"""Opt-in live CLI check. Sends only a tiny JSON response request; never generates images."""
import argparse
import asyncio
import sys
from pathlib import Path

from test_manga import mod
import cliagent
from peropix_plugin_manga_maker import cli_llm

parser = argparse.ArgumentParser()
parser.add_argument('agent', choices=['codex', 'claude-code'])
args = parser.parse_args()
item = next(x for x in cliagent.detect() if x['id'] == args.agent)
result = asyncio.run(cli_llm.chat(
    {'agent': args.agent, 'exe': item['path'], 'model': ''},
    'Return only the JSON object {"ok":true}. Do not use tools.',
    [{'role':'user','content':'Return {"ok":true}.'}],
    Path(__file__).resolve().parents[3] / '_tmp' / 'manga-cli-smoke',
))
print(result)
sys.exit(1 if result.get('error') else 0)
