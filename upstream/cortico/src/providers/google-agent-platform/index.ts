import type { ListedModel, ProviderModule } from '../base.ts';
import { isContextOverflow } from '../transport/errors.ts';
import { agentPlatformOptions, platformConfig, platformOrigin } from './config.ts';
import { AgentPlatformProvider } from './native.ts';

const reasoningTiers = [
  { id: 'low', label: 'Low', thinking: true, effort: 'low' },
  { id: 'medium', label: 'Medium', thinking: true, effort: 'medium' },
  { id: 'high', label: 'High', thinking: true, effort: 'high' },
] as const;

const VERTEX_MODELS: readonly ListedModel[] = [
  { id: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', contextWindow: 1048576, maxOutputTokens: 65536, inputImages: true },
  { id: 'gemini-4-carbon', displayName: 'Gemini 4 Carbon', contextWindow: 1048576, maxOutputTokens: 65536, inputImages: true },
  { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', contextWindow: 1048576, maxOutputTokens: 65536, inputImages: true },
  { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', contextWindow: 1048576, maxOutputTokens: 65536, inputImages: true },
  { id: 'gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', contextWindow: 1048576, maxOutputTokens: 65536, inputImages: true },
];

export default {
  id: 'google-agent-platform',
  title: 'Gemini · Google Cloud (Agent Platform)',
  description: 'Native Google Cloud GenerateContent with a service-account-bound Cloud API Key.',
  describe: { protocols: ['google-generate-content'], auth: ['api-key'], local: false, input: ['text', 'image'] },
  defaultBaseUrl: platformOrigin('global'),
  baseUrlSuggestions: ['global', 'us', 'eu'].map(platformOrigin),
  reasoningTiers,
  effortSuggestions: ['low', 'medium', 'high'],
  serviceTiers: [],
  temperatureNote: 'Gemini 4 Hydrogen / Carbon / Argon ignore custom sampling parameters.',
  localize: language => ({
    description: language === 'zh' ? '通过绑定服务账号的 Cloud API Key 调用 Google Cloud 原生接口。支持 Gemini 4 Hydrogen / Carbon / Argon。'
      : 'Use a service-account-bound Cloud API Key on Google Cloud Vertex Agent Platform.',
    temperatureNote: language === 'zh' ? 'Gemini 4 系列忽略自定义采样参数。' : 'Gemini 4 models ignore custom sampling parameters.',
  }),
  normalize: entry => ({ ...entry, baseUrl: entry.baseUrl.replace(/\/+$/, ''),
    options: { ...entry.options, ...agentPlatformOptions(entry) },
    ...(entry.spec ? { spec: { ...entry.spec, model: entry.spec.model.replace(/^models\//, '') } } : {}),
  }),
  config: platformConfig,
  validateEntry(entry, language) {
    const zh = language === 'zh';
    const { project, location } = agentPlatformOptions(entry);
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error(zh ? '请填写有效的 Google Cloud 项目 ID。' : 'A valid Google Cloud project ID is required.');
    if (!/^[a-z][a-z0-9-]*$/.test(location)) throw new Error(zh ? 'Google Cloud 位置无效。' : 'Invalid Google Cloud location.');
    if (entry.baseUrl !== platformOrigin(location)) throw new Error(zh ? '端点地址必须是与位置一致的官方 Google Cloud 地址。' : 'Endpoint must be the official Google Cloud origin for the configured location.');
    if (!entry.secret) throw new Error(zh ? '请配置 Cloud API Key 密钥变量名。' : 'A Cloud API Key secret name is required.');
    const { proxyUrl } = agentPlatformOptions(entry);
    if (proxyUrl) {
      const proxy = new URL(proxyUrl);
      if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/')
        throw new Error(zh ? '代理地址须为不含凭证和路径的 HTTP/HTTPS 地址。' : 'Proxy must be an HTTP/HTTPS origin without embedded credentials.');
    }
  },
  validateModel(_entry, spec) {
    if (!/^[A-Za-z0-9._-]+$/.test(spec.model)) throw new Error('Invalid Google model ID.');
    if ((spec.maxTokens ?? 8192) > 65536) throw new Error('This provider supports at most 65536 output tokens per request.');
  },
  accepts: (entry, _spec, mime) => entry.multimodal === true && ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'].includes(mime),
  contextOverflow: error => isContextOverflow(error) || ([0, 400, 413].includes(error.status)
    && /input token count[\s\S]*exceeds[\s\S]*maximum number of tokens allowed/i.test(error.body)),
  create(_name, entry, host) {
    const { project, location, proxyUrl } = agentPlatformOptions(entry);
    const client = new AgentPlatformProvider({ baseUrl: entry.baseUrl, project, location, proxyUrl, apiKey: host.secret(entry.secret!),
      host, multimodal: entry.multimodal === true });
    return {
      compatibilityKey: () => [project, location],
      listModels: async () => [...VERTEX_MODELS],
      contextWindow: () => 1048576,
      client, stop: () => client.close(),
    };
  },
} satisfies ProviderModule;
