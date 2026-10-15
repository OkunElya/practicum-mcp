# Local model variants

Ollama defaults to a 4k context, which cuts off the tool list. These Modelfiles reuse the
gpt-oss:20b weights with a larger window (no extra disk space):

```sh
ollama create gpt-oss-32k -f models/Modelfile.gpt-oss-32k   # fits a 16 GB GPU fully
ollama create gpt-oss-64k -f models/Modelfile.gpt-oss-64k   # ~2 GB spills to CPU unless the KV cache is quantized
```

Then: `env -u ALL_PROXY -u all_proxy hermes chat -m gpt-oss-32k -t mcp-practicum`
