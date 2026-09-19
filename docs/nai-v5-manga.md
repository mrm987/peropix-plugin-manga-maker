# NAI V5 만화 프롬프트 조사와 설계

확인일: 2026-09-14. 사용자 요청은 「짧은 스토리 → LLM이 페이지와 컷 결정 → 위치 프롬프트로 만화 생성」입니다.

## 공식 문서에서 확인한 내용

1. **페이지 전체 생성:** V5는 자연어로 패널 레이아웃, 캐릭터와 구도를 지시해 전체 페이지를 한 번에 만들 수 있습니다. 위치 지정과 함께 쓸 수 있습니다. [공식 발표](https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/), [V5 소개](https://novelai.net/v5)
2. **베이스/캐릭터 역할:** 베이스는 장면·스타일, 캐릭터 프롬프트는 개별 인물 특성을 담당합니다. 인물 수 태그는 베이스에, 개별 슬롯에는 수 없는 `girl`, `boy`, `other`를 씁니다. 인물 순서와 위치를 맞추고 자연어로도 보강하라는 권고가 있습니다. 위치 프롬프트는 사물에도 활용할 수 있다고 설명합니다. [멀티 캐릭터 문서](https://docs.novelai.net/en/image/multiplecharacters/)
3. **자유 좌표:** V5는 이전 모델의 5×5 격자 대신 자유로운 위치 지정을 지원합니다. [멀티 캐릭터 문서](https://docs.novelai.net/en/image/multiplecharacters/)
4. **텍스트:** 베이스 끝의 `Text:`에 내용을 모으고 항목 사이에 빈 줄을 넣습니다. 대사를 자연어로 한 번 더 서술할 수 있습니다. Full 750자, Curated 374자(공백·줄바꿈 포함)가 현재 문서의 한도입니다. [텍스트 렌더링 문서](https://docs.novelai.net/en/image/textrendering/)
5. **언어:** 영어·일본어를 공식 지원하며 다른 언어는 결과가 다를 수 있습니다. 한국어를 보장되는 언어로 안내하지 않습니다. [V5 소개](https://novelai.net/v5)
6. **프리셋 충돌:** V5 품질 프리셋은 `no text`를 붙입니다. Heavy 네거티브는 스크린톤·다중 시점 등을 억제하고 Furry Focus에는 `comic`도 들어갑니다. [품질 태그 문서](https://docs.novelai.net/en/image/qualitytags/), [네거티브 문서](https://docs.novelai.net/en/image/undesiredcontent/)

홍보의 22캐릭터를 API의 절대 상한이라고 해석하지 않았습니다. 로컬 PeroPix의 이전 웹 번들 조사 기록에는 UI 설정값 32와 차이가 기록되어 있습니다. 제작기의 페이지당 22슬롯 제한은 복잡도를 관리하는 자체 기획 제한입니다. 외부 API 페이로드 규격은 새로 구현하지 않고 기존 `nai.build_payload`에 위임합니다.

## 구현에서 정한 전략 (실측 품질 보장이 아닌 설계 판단)

★1.1.0부터 프롬프트는 레퍼런스 형식(태그만, `multiple views, comic, dynamic angle`, 카메라 태그 앞)으로 바뀌었다. 아래 좌표 예시의 베이스 문장·`Panel 1` 표기는 1.0.x의 기록이며 더 이상 생성되지 않는다. 현재 형식은 `docs/reference-prompt-analysis.md` 「1.1.0 재분석」과 README를 본다.

1.0.1에서 [원본 프롬프트 분석](reference-prompt-analysis.md)을 반영한 「좌표 중심」 모드를 추가했습니다. 1.0.2는 LLM이 컷 영역과 전체 구성을 직접 지정하는 자유 배치를 기본으로 사용합니다. 아래의 고정 레이아웃·경계 예시는 기존 템플릿과 상세 지시 모드의 설명입니다. 좌표 중심 모드에서는 컷 장면과 화자 대사를 지역 슬롯에 두고, 내레이션에 별도 슬롯을 사용합니다.

- **2단계 기획:** 먼저 전체 이야기와 외형 설정표를 JSON으로 생성합니다. 그다음 각 페이지를 순차적으로 기획하며 전체 줄거리와 앞선 콘티를 함께 보냅니다. 길게 한 번에 출력하다 JSON이 잘리는 문제를 줄이고 페이지 간 연결 정보를 유지하려는 선택입니다.
- **레이아웃은 템플릿:** LLM이 한 컷, 2/3/4줄, 2×2, 2×3, 위/아래 큰 컷 중 선택합니다. 코드가 서로 겹치지 않는 사각형을 정합니다. 패널 순서는 읽는 순서로 유지하고 좌표 배치만 RTL/LTR에 맞춥니다.
- **각 등장마다 슬롯:** 같은 인물이 1·3·4컷에 등장하면 같은 외형 프롬프트를 공유하는 별도 슬롯 세 개를 만듭니다. 한 컷의 두 인물은 슬롯 둘을 사용합니다. 인물 없는 컷에는 그 컷의 배경을 설명하는 위치 슬롯 하나를 둡니다.
- **좌표 이중 지시:** 페이지 베이스에 패널의 위/아래·좌/우 위치와 경계를 서술하고 개별 슬롯에도 패널 번호·장소를 반복합니다. 좌표는 해당 컷 안의 상대 위치를 전체 이미지의 정규화 좌표로 바꿉니다.
- **문자 블록:** 대사는 화자/말풍선 설명 안에 따옴표로 적고, `Text:` 블록은 플러그인이 붙이지 않습니다(1.0.8). 호스트 `backend/naitext.py`가 따옴표 대사를 모아 `teXt:` 블록을 한 번 만듭니다. 1.0.7까지는 플러그인이 명시적 블록을 직접 붙였는데, 같은 대사가 두 번 실렸습니다.
- **프리셋:** `quality_preset=none`, `uc_preset=none`. 베이스에 `very aesthetic, masterpiece`를 직접 추가합니다. 대사 없음 모드에서만 `no text`와 말풍선 없는 구도를 지시합니다.
- **외형 일관성:** 캐릭터 태그·머리·얼굴·의상 묘사를 반복합니다. 이미지 참조를 이용하는 방식은 이번 버전에 넣지 않았습니다.

## 좌표 예시

오른쪽부터 읽는 2×2 페이지의 첫 컷은 오른쪽 위입니다. 사각형은 `(x=.5, y=0, w=.5, h=.5)`입니다. 그 안의 인물 위치가 `(x=.45, y=.60)`이면 전체 페이지 좌표는 다음과 같습니다.

```text
page_x = panel_x + panel_width  * local_x = .5 + .5 * .45 = .725
page_y = panel_y + panel_height * local_y =  0 + .5 * .60 = .300
```

베이스에는 다음처럼 씁니다.

```text
comic, manga, monochrome, black and white manga, screentone, ink lineart,
very aesthetic, masterpiece. A complete 4-panel comic page with distinct
black panel borders and white gutters. Read top to bottom, right to left.
Panel 1, top right, bounds x=0.50..1.00, y=0.00..0.50:
A girl enters a quiet Japanese living room through the doorway.
In panel 1, a speech bubble with its tail pointing to Marin reads "おじゃまします。".
...
Text: おじゃまします。
```

해당 캐릭터 슬롯은 다음 형태입니다. 이 데이터는 PeroPix의 `GenBody.characters` 규격이며, NAI 전송용 `v4_prompt.caption.char_captions`와 `use_coords`는 호스트가 구성합니다.

```json
{
  "prompt": "girl, kitagawa marin, long blonde hair, pink eyes, white shirt, plaid skirt. Panel 1, top right only. Entering the room and looking toward the sofa.",
  "uc": "",
  "center": {"x": 0.725, "y": 0.3},
  "use_coord": true
}
```

위치는 생성 모델의 구도 지시입니다. 실제 패널 경계를 고정하는 자르기·합성·마스크와는 다릅니다. 문서상 가능한 방법과 실제 특정 줄거리의 생성 품질을 구분해야 합니다. 이번 검증은 프롬프트 구조·좌표·큐·저장 흐름에 대한 오프라인 검증입니다.
