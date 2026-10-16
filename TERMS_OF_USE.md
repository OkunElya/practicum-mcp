# Terms of use

Practicum MCP is an independent, unofficial project. It is **not made, endorsed or supported by
Yandex** or ANO «Яндекс Практикум». "Yandex", "Яндекс Практикум" and "Практикум ИИ" are names of
their owners and are used here only to say what the tool works with.

This page is not legal advice. It points out what Yandex's own terms say about the kind of thing
this tool does, so you can decide for yourself. If anything here differs from Yandex's current
documents, the documents win: they change, so read them yourself.

## By using this tool you accept that

1. **You act on your own account and at your own risk.** The tool reads, clicks and types in your
   logged-in Practicum tab, and asks Практикум ИИ questions as you. Everything it does is done
   under your name.
2. **You are responsible for following Yandex's terms**, including the ones below. The project's
   authors are not responsible for any consequences for your account, your studies or your
   certificates: a block, cancelled results, lost access or anything else.
3. **The software comes with no warranty.** It is licensed under the
   [GNU GPL v3 or later](LICENSE), which says it is provided "as is" (sections 15–16). Answers it
   gives or submits may be wrong, and so may answers from Практикум ИИ or a local model.
4. **You check what is submitted.** Anything recorded on your account (quiz answers, task checks,
   messages to Практикум ИИ, finishing a lesson) waits for your approval in the sidebar or the
   overlay. Turning that off in the popup is your decision.

## What Yandex's terms say

### Yandex Practicum service terms

[Условия использования сервиса «Яндекс Практикум»](https://yandex.ru/legal/practicum_termsofuse/)
(the version published on 6 March 2026, when this page was written):

- **4.1** prohibits using technical or software means to obtain or use the Materials (followed by
  the words «в автоматическом режиме» — "in automatic mode"), and says the service may use tools to
  detect suspicious activity that doesn't comply with the terms: «Не допускается использование
  технических или программных средств для получения или использования Материалов…»;
  «…средства обнаружения подозрительной активности Пользователей, не соответствующей Условиям».
  4.1 also forbids copying, reproducing, adapting or distributing the Materials.
- **7.2** prohibits copying the service's information «с использованием автоматических и иных
  программных средств получения доступа к данным» (with automated or other software tools for
  accessing data) without written permission, and says the information is «исключительно для
  личного некоммерческого использования» (for personal non-commercial use only).
- **1.1.11 and 2.1** describe the service as being for your own, independent learning
  («самостоятельного обучения», «самостоятельного прохождения им выбранной в Сервисе Программы»).
- **2.14, 5.1–5.3**: the service is provided «как есть» (as is), and Yandex is not responsible for
  the accuracy of AI-generated information.

**In plain terms:** this tool is exactly a software means of reading and working with Practicum's
materials, so using it on the real platform can conflict with 4.1 and 7.2, and the service says it
can detect such activity. Showing every step on screen and waiting for your approval does not
change that.

### Yandex generative AI terms (Практикум ИИ)

The Practicum terms refer to
[Условия использования генеративных технологий ИИ Яндекса](https://yandex.ru/legal/yagpt_termsofuse)
for the AI features (the version published on 24 October 2025):

- **2.2.2–2.2.4**: don't get around the service's limits, don't disrupt the service or exceed
  usage limits, and don't use automatic means to collect content at a volume that threatens its
  normal operation.
- **2.2.5**: don't present AI-generated content as the result of human work where using AI is not
  expected or is not allowed.
- **2.1.3, 2.1.5**: you have to check the generated content yourself, and you are responsible for
  your requests.
- **2.1.1–2.1.2, 4.2**: no guarantee that content is generated, correct or relevant; the service is
  provided as is.

The agent in this project can send Практикум ИИ many messages in a row (`ask_platform_ai`, and
agent mode with the Практикум ИИ backend). Every message waits for your approval, but you decide
how much to send.

### Other documents that apply

- [Пользовательское соглашение сервисов Яндекса](https://yandex.ru/legal/rules) (Yandex user
  agreement)
- [Политика конфиденциальности](https://yandex.ru/legal/confidential) (privacy policy)

## What this means for you

- **Reading** — your progress, a lesson as text, explanations from Практикум ИИ — is closest to
  what the service is for, but the tool still reads the pages with software, which 4.1 and 7.2
  address.
- **Letting an agent answer quizzes or solve tasks for you** goes against the idea of independent
  learning in 1.1.11 and 2.1, and your results may not reflect what you know. Graded or certified
  work is your responsibility.
- **Don't share course material** the tool shows you (lesson text, tasks, answers, exported chats,
  logs): 4.1 and 7.2 forbid copying and distributing it. The project itself never commits it: the
  scraped lessons and eval scenarios are excluded from the repository.
- **If you are unsure, ask Yandex Practicum's support** whether a given use is allowed, or use the
  tool only against the offline simulator in [`bridge/evals/`](bridge/evals/).

## Privacy

The tool keeps everything on your computer:

- The bridge listens on 127.0.0.1 only and talks to nothing but the extension, your MCP client and,
  in agent mode, your local Ollama.
- What leaves your machine is what your browser sends to practicum.yandex.ru anyway, plus whatever
  you let the agent send to Практикум ИИ or your MCP client sends to its own model provider (for
  example, Claude Code sends tool results to Anthropic).
- Logs (`~/.config/practicum-mcp/agent.log`, `chat.log`) and exported chats contain page content
  from your account; they stay where they are written unless you move them.
