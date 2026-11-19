import { createRequire } from 'node:module';
import { BaseProvider } from '../base.ts';
import type { ProviderHost } from '../base.ts';
import type { Request } from '../../protocol/open-responses/index.ts';
import type { GenerateOptions, Generation } from '../../core/generation.ts';
import { generate } from '../transport/response-http.ts';
import { buildGoogleBody, GoogleResponseAssembly, parseGoogleResponse } from './protocol.ts';

const require = createRequire(import.meta.url);
function createProxyDispatcher(proxyUrl: string): { close?: () => Promise<void> } | undefined {
  try {
    const { ProxyAgent } = require('undici');
    if (ProxyAgent) {
      return new ProxyAgent({ uri: proxyUrl, connections: 4, keepAliveTimeout: 1000, keepAliveMaxTimeout: 1000 });
    }
  } catch {}
  try {
    const { EnvHttpProxyAgent } = require('internal/deps/undici/undici');
    if (EnvHttpProxyAgent) {
      return new EnvHttpProxyAgent({
        httpProxy: proxyUrl,
        httpsProxy: proxyUrl,
        noProxy: '127.0.0.1,localhost',
        connections: 4,
        keepAliveTimeout: 1000,
        keepAliveMaxTimeout: 1000,
      });
    }
  } catch {}
  return undefined;
}

export interface AgentPlatformProviderOptions {
  baseUrl: string;
  project: string;
  location: string;
  apiKey: string;
  proxyUrl?: string;
  host: Pick<ProviderHost, 'readBlob' | 'keepThinking' | 'log'>;
  multimodal: boolean;
}

/** Native GenerateContent with one dispatch, server-side billing, and signed part replay. */
export class AgentPlatformProvider extends BaseProvider {
  private readonly dispatcher?: { close?: () => Promise<void> };
  constructor(private readonly config: AgentPlatformProviderOptions) {
    super();
    if (config.proxyUrl) this.dispatcher = createProxyDispatcher(config.proxyUrl);
  }

  async close(): Promise<void> { await this.dispatcher?.close?.(); }

  async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const config = this.config;
    if (!config.apiKey) throw new Error('Google Cloud API Key is required.');
    const model = (request.model ?? '').replace(/^models\//, '');
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error('Invalid Google model ID.');
    const origin = options.origin ?? { instance: 'google-agent-platform', module: 'google-agent-platform', model,
      compatibilityDomain: `${config.baseUrl}/${config.project}/${config.location}` };
    const nativeOptions = { ...options, origin };
    const resource = `/v1/projects/${encodeURIComponent(config.project)}/locations/${encodeURIComponent(config.location)}/publishers/google/models/${encodeURIComponent(model)}`;
    return generate(request, nativeOptions, origin, {
      url: `${config.baseUrl.replace(/\/+$/, '')}${resource}:${options.onEvent ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
      body: buildGoogleBody(request, nativeOptions, { enabled: () => config.multimodal, read: config.host.readBlob }, config.host.keepThinking()),
      redirect: 'error',
      dispatcher: this.dispatcher,
      headers: () => ({ 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey }),
      refresh: async () => false,
      assembly: () => new GoogleResponseAssembly(request, nativeOptions),
      parse: raw => parseGoogleResponse(raw, request, nativeOptions),
      failure: async () => false,
      succeeded: () => {},
      log: config.host.log,
    });
  }
}
