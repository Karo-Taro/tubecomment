// Пресеты провайдеров. Почти все говорят на OpenAI-совместимом /chat/completions,
// Anthropic — на своём Messages API. Хотите добавить провайдера — допишите строку сюда.
// format: 'openai' | 'anthropic'

// Мост TubeComment (bridge/tubecomment-bridge.mjs): CLI-агенты и прокси на этом компьютере
export const BRIDGE = 'http://127.0.0.1:47331';

export const PROVIDERS = [
  { id: 'bridge', name: 'CLI-агент через мост (Claude Code, Codex, Gemini CLI)', format: 'openai', baseUrl: BRIDGE + '/v1', model: 'claude', local: true, bridge: true },
  { id: 'openai', name: 'OpenAI', format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic Claude', format: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', name: 'Google Gemini', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', name: 'OpenRouter', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', name: 'Groq', format: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys' },
  { id: 'deepseek', name: 'DeepSeek', format: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'mistral', name: 'Mistral', format: 'openai', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'xai', name: 'xAI Grok', format: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'grok-3-mini', keyUrl: 'https://console.x.ai' },
  { id: 'ollama', name: 'Ollama (локально)', format: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', local: true },
  { id: 'lmstudio', name: 'LM Studio (локально)', format: 'openai', baseUrl: 'http://localhost:1234/v1', model: '', local: true },
  { id: 'litellm', name: 'LiteLLM Proxy (локально)', format: 'openai', baseUrl: 'http://localhost:4000/v1', model: '', local: true, keyUrl: 'https://docs.litellm.ai/docs/simple_proxy' },
  { id: 'cliproxy', name: 'CLIProxyAPI (подписка как API)', format: 'openai', baseUrl: 'http://localhost:8317/v1', model: '', local: true, keyUrl: 'https://github.com/router-for-me/CLIProxyAPI' },
  { id: 'custom', name: 'Свой адрес (OpenAI-совместимый)', format: 'openai', baseUrl: '', model: '' },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[PROVIDERS.length - 1];
