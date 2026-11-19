import type { ConfigGroup, LLMProviderEntry } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';

export interface AgentPlatformOptions { project: string; location: string; proxyUrl?: string; }

export function agentPlatformOptions(entry: LLMProviderEntry): AgentPlatformOptions {
  return { project: String(entry.options?.project ?? '').trim(), location: String(entry.options?.location ?? 'global').trim(),
    ...(entry.options?.proxyUrl ? { proxyUrl: String(entry.options.proxyUrl).trim() } : {}) };
}

export function platformOrigin(location: string): string {
  return location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
}

export function platformConfig(name: string, entry: LLMProviderEntry, language: Language): ConfigGroup[] {
  const zh = language === 'zh';
  return [{
    id: `llm.${entry.kind}.${name}.cloud`, owner: `provider:${entry.kind}`,
    schema: { type: 'object', title: zh ? 'Google Cloud 项目' : 'Google Cloud project', properties: {
      [`providers.${name}.options.project`]: { type: 'string', title: zh ? '项目 ID' : 'Project ID', 'x-hot': true },
      [`providers.${name}.options.location`]: { type: 'string', title: zh ? '位置' : 'Location',
        description: zh ? 'global 使用全局地址；区域须与端点地址一致。' : 'Use the global endpoint for global; regional endpoint and location must agree.', 'x-hot': true },
      [`providers.${name}.options.proxyUrl`]: { type: 'string', title: zh ? 'HTTP 代理地址' : 'HTTP proxy URL',
        description: zh ? '仅此端点使用。留空直连；填写完整 http:// 或 https:// 地址。' : 'Applies only to this endpoint. Leave empty for direct access; otherwise use a full http:// or https:// URL.', 'x-hot': true },
    } },
  }];
}
