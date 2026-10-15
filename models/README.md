# Local model variants

Ollama defaults to a 4k context, which cuts off the tool list. These Modelfiles reuse the
gpt-oss:20b weights with a larger window (no extra disk space):

```sh
ollama create gpt-oss-32k -f models/Modelfile.gpt-oss-32k   # fits a 16 GB GPU fully
ollama create gpt-oss-64k -f models/Modelfile.gpt-oss-64k   # ~2 GB spills to CPU unless the KV cache is quantized
```

Both also set `temperature 0.2` instead of gpt-oss's default of 1.0. On the simulated trainer
task in [`bridge/evals/`](../bridge/evals/), 0–0.7 solved 9–12 runs out of 12, while 1.0 solved
7/12 and made more tool errors and checks. 0 is nearly deterministic: its retries repeat the
same mistake. `practicum-local-agent` and `practicum-chat` default to 0.2 as well.

Then: `env -u ALL_PROXY -u all_proxy hermes chat -m gpt-oss-32k -t mcp-practicum`
