# Third-party notices

This repository is distributed under **AGPL-3.0-or-later**. The following components keep their original licenses and copyright notices. Their presence does not relicense them under AGPL.

## Upstream frameworks

| Component | Version | License | Copyright / source |
| --- | --- | --- | --- |
| `cortico` | 0.2.15 | MIT | Copyright (c) 2026 Phantivia; `upstream/cortico/LICENSE` |
| `@deepseek-ai/dsh-agent-loop` | 0.1.5-rc.2 | MIT | DeepSeek; `upstream/dsh-agent-loop` |
| `@deepseek-ai/dsh-compaction-basic` | 0.1.5-rc.2 | MIT | DeepSeek |
| `@deepseek-ai/dsh-client-file-upload` | 0.1.5-rc.2 | MIT | DeepSeek |
| `@deepseek-ai/dsh-session` | 0.1.5-rc.2 | MIT | DeepSeek |
| `@deepseek-ai/dsh-api-session-controller` | 0.1.5-rc.2 | MIT | DeepSeek |
| `@deepseek-ai/dsh-token-meter` | 0.1.5-rc.2 | MIT | DeepSeek |
| `@deepseek-ai/dsh-tools` | 0.1.5-rc.2 | MIT | DeepSeek |
| `@deepseek-ai/cordis` | 4.0.2 | MIT | DeepSeek; `vendor/deepseek-ai-cordis-4.0.2.tgz` |
| `@tina/cortico-host-client` | 0.1.0 | MIT | This project |

## Vendored worlds

| Package | License | Upstream |
| --- | --- | --- |
| `cortico-world-audio-play` 0.4.0-canbot.1 | MIT | AqualCross |
| `cortico-world-tts` 0.1.4 | MIT | AqualCross |
| `cortico-world-stt` 0.3.0 | MIT | AqualCross / Lostdegree |
| `cortico-world-tina-mobile` 0.1.1 | MIT | This project |
| `cortico-world-tina-link` 0.1.0 | MIT | This project |
| `cortico-world-tina-linux-tools` 0.1.0 | MIT | This project |
| `cortico-world-codex-bridge` 0.3.0-tina.1 | MIT | This project |
| `cortico-world-canbot` 0.8.0-candidate.8 | MIT | This project |
| `cortico-bot-tina-main` 0.1.0 | MIT | This project |

## Vendored memory helpers

| Component | License | Upstream |
| --- | --- | --- |
| `cortico-world-memory` 0.2.7 (transpiled into `self-mem/vendor/cwm027`) | MIT | https://github.com/hth768/cortico-world-memory |
| `dsh-session-codec` 0.2.1-rc.2 | MIT | DeepSeek |

## At-runtime dependencies

Some optional capabilities (STT, TTS, audio playback) call external services or system players. Those services are not bundled and are governed by their own terms:

- Alibaba Cloud Bailian / DashScope (Qwen-ASR, Qwen-Audio-TTS)
- Any OpenAI-compatible local STT/TTS server you configure
- System players: `ffplay`, `mpv`, `vlc`, `paplay`, `aplay`, Windows WPF MediaPlayer

The default configuration contains no credentials and makes no external request until you configure a provider and enable a World.
