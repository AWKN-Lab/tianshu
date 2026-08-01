/**
 * awkn-local-action-runner — Pipeline 定义加载器
 *
 * 读取 .awkn/actions/*.json，用 zod 校验。
 * 不引入 YAML parser，先用 JSON 格式。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PipelineSchema, type PipelineDef } from './types.js';

/** 加载指定名称的 Pipeline 定义 */
export function loadPipeline(actionsDir: string, name: string): PipelineDef {
  const jsonPath = resolve(actionsDir, `${name}.json`);
  if (!existsSync(jsonPath)) {
    throw new Error(`Pipeline definition not found: ${jsonPath}`);
  }
  const raw = readFileSync(jsonPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return PipelineSchema.parse(parsed);
}

/** 列出可用的 Pipeline 名称 */
export function listPipelines(actionsDir: string): string[] {
  if (!existsSync(actionsDir)) return [];
  return readdirSync(actionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}
