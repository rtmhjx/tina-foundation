<!-- Owner: src/providers/google-agent-platform/index.ts, src/providers/google-agent-platform/native.ts, src/providers/google-agent-platform/protocol.ts -->

# Google Cloud Agent Platform

`google-agent-platform` calls the native Google Cloud `GenerateContent` API (`streamGenerateContent?alt=sse` / `generateContent`). Each endpoint declares a Cloud project ID and location. Credentials use a service-account-bound Cloud API Key in the endpoint's `.env`. Supports Gemini 4 Hydrogen, Carbon, Argon, and Gemini 3.x models with `thinkingLevel` (`LOW`, `MEDIUM`, `HIGH`) and lossless `thoughtSignature` replay.
