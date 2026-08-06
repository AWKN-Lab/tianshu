#!/usr/bin/env python3
"""Inspect absorption-registry.json Q-* entries."""
import json

REG = r'D:\awkn-lab\awkn引擎\docs\absorption-registry.json'
reg = json.load(open(REG, encoding='utf-8'))
for e in reg['entries']:
    if e['id'].startswith('Q-'):
        print(f"{e['id']:<4} implFiles={e['implementedFiles']}")
        first_path = list(e['sha256'].keys())[0]
        first_sha = list(e['sha256'].values())[0]
        print(f'      first sha key: {first_path}')
        print(f'      first sha    : {first_sha[:24]}...')
        prov = e.get('sha256Provenance', {})
        print(f'      provenance path: {first_path}')
        print()