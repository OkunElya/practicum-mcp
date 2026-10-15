# Yandex Practicum: platform findings

Goal: let a small LLM work with practicum.yandex.ru through a Firefox/Waterfox
extension. These are the inspection results the tool layer will be designed from.

Collected 2026-10-14/15 on the user's logged-in session (profession `ap-backend-st`),
using the scripts in [`scripts/inspect/`](../scripts/inspect/).

Status: inspection complete; the extension and bridge built from it are in `extension/` and `bridge/`.

---

## 1. How to reproduce the inspection

1. Fully quit Waterfox, then run `waterfox --remote-debugging-port 9222`.
   Starting it with the flag while an instance is already running is silently ignored.
2. Run `node scripts/inspect/<script>.mjs`. All scripts use `lib.mjs`, which connects
   over **WebDriver BiDi** (`ws://127.0.0.1:9222/session`, puppeteer-core) and picks the
   first tab whose URL contains `practicum.yandex.ru`.

| Script | Purpose | Side effects |
|---|---|---|
| `tabs.mjs` | list tabs | none |
| `overview.mjs` | framework, React roots, globals, test-ids, scripts | none |
| `deep.mjs` / `ai.mjs` | Redux state shape, RTK Query endpoints, YaGPT slice | none |
| `lesson.mjs`, `lesson-survey.mjs`, `theory.mjs` | lesson state, theory block tree, rendered interactive elements | none |
| `walk-lessons.mjs` | follows `next_lesson_id` via `GET /api/lessons/{id}/`, inventories block types | none (GET only) |
| `trainer.mjs` | code-trainer page: editor, buttons, slices | none |
| `editor.mjs get\|set` | read/replace Monaco content | `set` changes the draft |
| `click-and-capture.mjs "<text>"` | click by visible text, record traffic | whatever the click does |
| `act.mjs --watch <css> <css>...` | click selectors in order, record traffic | whatever the clicks do |
| `tasks.mjs` | trainer tasks (description, hints, solved) + trainer state | none |
| `controls.mjs [css-scope]` | visible clickable controls (test-id, label, href, handlers); default = left rail + header | none |
| `profile-progress.mjs` | main-page progress: bars, course cards, RTK queries, `profileReducer.profile` | none |
| `webserver.mjs` | `web_server` trainer: panes/file tree, Monaco models, preview iframe, webserver state | none |
| `net-watch.mjs [--seconds N] [--click css] [--type css text] [--enter]` | do UI steps, record all network (+SSE bodies) and `chatYaGPT` diffs → `net-watch-last.json` | the steps |
| `macaroni.mjs "<left>=<right>"… [--submit]` | connect QuizMacaroni pairs by clicking left then right labels | quiz state |
| `choice.mjs "<option>"…` | fill QuizChoice dropdowns in prompt order | quiz state |
| `cards.mjs [--retry] [--move "<card>=<column>"]… [--submit]` | QuizCards: retry (with confirm), click-move cards, submit with recorded payload | quiz state |
| `watch-state.mjs [sec] [--click <css>]` | poll button disabled-state + Redux status fields + network, log every transition | the click |
| `trainer-step.mjs <check\|run\|hint\|css:…> [codeFile]` | set code, click, record bodies via BiDi, diff trainer state | whatever the click does |
| `recorder.mjs` | in-page fetch/XHR body recorder (patches page globals; prefer BiDi bodies) | none by itself |
| `reload.mjs`, `shot-el.mjs` | reload the tab, screenshot one element | reload |

**BiDi gotchas**
- Firefox allows only **one** BiDi session, and does **not** end it when the socket
  drops. A crashed script locks you out ("Maximum number of active sessions") until
  the browser restarts. `lib.mjs` ends the session on errors and signals.
- `HTTPRequest.resourceType()` is unsupported over BiDi, and response bodies aren't
  exposed.

---

## 2. Application architecture

| Aspect | Finding | Consequence for tools |
|---|---|---|
| Framework | React **18.2.0** production build from `yastatic.net`, globals `window.React` / `window.ReactDOM`, Vite bundles | fibers reachable via `__reactFiber$*` / `__reactProps$*` on DOM nodes |
| Root | `div#mount` (`__reactContainer$*`) | entry point for finding the store |
| Component names | minified (`t`, `mu`, `Zl`); only HOC wrappers are readable (`Connect(..)`, `withRouter(..)`) | can't identify UI by component name |
| State | **Redux** store (redux-saga, socket.io namespaces, dynamic `addReducers`) + **RTK Query** (`state.api`) | read data from the store, not the DOM |
| Store access | walk fibers from `#mount` until `memoizedProps.store.getState` exists | needs the MAIN world (or `wrappedJSObject` in an isolated content script) |
| Routing | react-router **v5**; `history` (`push/replace/goBack/listen`) found on a fiber prop | SPA navigation without reload |
| i18n | react-intl (`FormattedMessage`) | |
| Design system | "prisma" with BEM classes (`prisma-button2`, `course-card__title`, `theory-viewer__block_type_*`) | readable, fairly stable selectors |
| Test hooks | `data-test-id` on ~60–90 elements (`check-task-button`, `next-lesson-control-button`, `sidebar-gpt-button`, `theory-action-button-<blockId>`, …) | best DOM anchors |
| Accessibility | react-aria pressables (`data-react-aria-pressable`); **modals have no `role=dialog` / `aria-modal`**; many clickables are `<div|section|header|a(no href)|svg onClick>` | detect clickables via React props; detect modals as the "topmost fixed layer covering most of the viewport"; clicks must send real pointer events |
| Editor | **Monaco 0.52** on `window.monaco` (trainer pages only) | `monaco.editor.getModels()[0]` = `file:///main.py` |
| Preloaded data | `window.__preloadedData__` (`me`, config, `serverhubUrl`, …) and `window.__preloadedState__` | user/profession context without API calls |

Other origins: `serverhub.praktikum-services.ru` (+ `wss://`), `feynman.praktikum.yandex.net`,
Yandex Messenger iframe (support chat), plus analytics (Metrika, apigw `/tr/`, mail.ru, tomi.ai)
which tools should ignore.

---

## 3. Pages and navigation

| Page | URL | Notes |
|---|---|---|
| Profile / course grid | `/profile/{professionSlug}/` | course cards are `<button class="card course-card">` |
| Course modal | same URL | `div.skills-modal`; tabs "Курс" / "Тема" are `<section onClick>`; topics are `<a>` **without href** (`onClick`); lessons are real `<a href="/learn/...">`; close button is an unlabeled `<svg class="icon-cross" onClick>` |
| Theory lesson | `/learn/{slug}/courses/{courseId}/sprints/{sprintId}/topics/{topicId}/lessons/{lessonId}/` | SPA route; left sidebar with topics (`header.sidebar__topic-header onClick`) and lessons |
| Code trainer | `/trainer/{slug}/lesson/{lessonId}/task/{taskId}/?hideTheory=1` | **full page load** (anything injected into the page is lost); split view: theory + tasks panel, Monaco editor, result panel |

Lesson types (`lesson.lesson_type`) seen across 77 lessons: `web` (theory/quizzes),
`serverless` (Python trainer with tasks), `web_server` (trainer + web server),
`homework_without_review` (project).

---

## 4. Where the data lives

### Redux slices (most useful)

| Slice | Contents |
|---|---|
| `proficiencyReducer.lesson` (theory pages) / `trainerReducer.lesson` (trainer) | the full lesson: `name`, `theory` tree, `tasks[]` (with `description`, `hints[]`, `solved`), `next_lesson_id`, `solved`, `lesson_type`, `course_*`, `topic_*`, `sprint_id` |
| `proficiencyReducer.proficiency` | profession with `courses[17]` |
| `theoryBlocksReducer.quizzes` | the user's submitted quiz answers for this lesson |
| `trainerReducer` | editor/run state, `playgroundLogs`, `attemptsInLesson`, `isTaskHintVisible`, `config.pyodide` |
| `chatYaGPT.aiChatReducer` / `aiHelperReducer` | the platform's own AI chat: `messages`, `chatId`, `inputValue`, `suggestions`, `pendingStreamRequest` (streamed) |
| `api.queries` (RTK Query) | e.g. `getProfession`, `getAiChats{lesson_id, scenario:"lesson_question"}`, `getTopicProgressByLesson`, `getNotifications`, `getProfessionAssessments` |

### Theory tree (`lesson.theory`)

`{id, tree_id, type, content, nested[]}`, recursive, with `RootLayout` at the root.
**The whole lesson is present as Markdown**, including parts that are still hidden
behind action buttons or blocking quizzes. `read_lesson` can return it without any clicks.

Block types found (walk of 77 lessons):

| Type | Content | Interactive? |
|---|---|---|
| `Markdown` | `{markdown}` | no |
| `CutContainer` | `{title}` + nested blocks (collapsible) | expand only, no API |
| `WideLayout`, `SideBySide{src1,src2}`, `Gallery{images[]}` | layout / images | no |
| `Dialog` | `[{side, type, message, character}]` (chat-style) | no |
| `ActionButton` | `{id, text, options, questions}` reveals the following blocks | **yes**, writes |
| `ActionLinkButton` | `{link, text, isBlocking}` (download) | link |
| `QuizSelect` | `{id, type: checkbox\|radio, content, options[{id, content, correct, feedback-*}], blocking, show_all_feedback}` | **yes**, writes |
| `QuizChoice` | matching via dropdowns: `options[]`, `questions[{content, correct_option}]` (prompts can be "1.", "2."… for ordering) | **yes**, writes `user_answer: {questionId: optionId}`; retryable |
| `QuizCards` | sort into groups: `options[{correct_section}]` | **yes**, writes `user_answer: {source: [], sectionId: [optionIds]}`; retryable |
| `QuizText` | free text: `validations[{type:"strict"\|"regexp", match}]`, `result_text` | **yes**, writes `user_answer: "<text>"`; single attempt |
| `QuizMacaroni` | match left↔right: `options.left/right.choices`, `shuffle_left/right`, `correct_answers` | **yes**, writes `user_answer: [[leftIdx, rightIdx], …]` |
| `QuizCoding` | code exercise inside a theory lesson: `panes` (starter), `language`, `hint`, `test` + `answer_panes` (⚠️ leak), `coderun_config` | **yes**; saved `user_answer: {panes, run_only, test_result}`; UI not inspected yet. Very common (57 in 45 sampled lessons) |
| `QuizChat` | dialog quiz: a state machine of bot messages and reply buttons (`state`, `initial`, `messages[].answers[]` with `isValid`, `feedback`) | **yes**, one reply at a time + «Далее»; see actions.md C12 |
| `QuizFeedback` | survey: `slides[]` (`likert_scale` {statements, grades}, `text` {placeholder}) | writes once at the end: `user_answer: {likertSlideId: {statementId: gradeId}, textSlideId: text}` |

> ⚠️ **The answer keys reach the browser for every quiz type** (`correct`,
> `correct_option`, `correct_section`, `validations`, `correct_answers`, `result_text`).
> Quiz grading happens in the browser: the server stores `passed: null`. When the
> model is given quiz content, these fields should be **stripped by default**,
> otherwise "answering" just means copying the key. Exposing them is a deliberate
> decision for later.

---

## 5. API catalogue (same-origin, cookie session)

All under `https://practicum.yandex.ru`. They're plain `fetch` calls with
`credentials: include`, so an extension script in the page can call them directly.

### Reads (safe)

| Endpoint | Returns |
|---|---|
| `GET /api/lessons/{lessonId}/` | full lesson (same as `proficiencyReducer.lesson`), **no side effects** |
| `GET /api/lessons/{id}/quizzes/` | previous quiz/action-button submissions |
| `GET /api/lessons/{id}/theory_block_answers/` | |
| `GET /api/progress/lesson/{id}/?sprint_id=` | topic → lessons with `solved`, `next_topic`, `course`, `sprint` |
| `GET /api/subscriptions/{subId}/courses/` | `[{id, name, solved, course_type}]` |
| `GET /api/subscriptions/{subId}/sprints/`, `/finished_lessons_count/` | |
| `GET /api/v2/professions/{slug}/`, `GET /api/professions/` | profession / catalogue |
| `GET /api/tasks/{taskId}/?slug=` | trainer task |
| `GET /api/lesson_types/{slug}/` | lesson-type flags (`is_homework`, `is_client_trainer`, …) |
| `GET /api/gpt/chats/?lesson_id=&scenario=lesson_question` | the platform AI chats for a lesson |

`subId` (e.g. from `me.subscriptions`) is in `__preloadedData__.me.subscriptions[]`.

### Writes (observed request/response)

| Trigger | Request | Response / effect |
|---|---|---|
| opening a lesson | `POST /api/lessons/{id}/checkin/` (no body) | `OK`; marks it visited. **Navigation has side effects.** |
| opening a trainer task | `PATCH /api/subscriptions/{subId}/current_lesson/` | |
| `ActionButton` | `POST /api/lessons/{id}/quizzes/` `{"user_answer":true,"markup":{"id":"expander-<content.id>","type":"actionButton"}}` | 201; next blocks revealed |
| `QuizSelect` "Проверить" | `POST /api/lessons/{id}/quizzes/` `{"id":"<blockId>","user_answer":["<optionId>",…],"markup":<the block's content incl. answer key>}` | 201, `passed:null`; **one attempt**: the quiz locks, shows all feedback and unblocks what follows, even if wrong |
| "К следующему уроку" (`tid=next-lesson-control-button`) | `POST /api/lessons/{id}/solve/` `{}` | `{"result":true,"has_access_to_next_lesson":true,"can_be_reset":false}`, then navigates |
| trainer "Проверить" (`tid=check-task-button`) | `POST /api/serverless/check_task/{taskId}/` `{"panes":[{"name":"main.py","opened":true,"content":"…","language":"python"}]}` | see §5a. Frequently `400 PY.check_task "Failed to parse AstOutput"` (platform instability), so **retry** |
| trainer "Выполнить код" (`button[aria-label="Выполнить код"]`) | `POST /api/serverless/run_code/` `{"task_id":"…","panes":[…]}` | run without checking |
| analytics | `POST /api/event_collector/`, `/api/v1/sendLatencyMetrics` | ignore |

### 5a. Code trainer flow (lesson 5, three `serverless` tasks, all solved)

**Task data:** `GET /api/tasks/{taskId}/?slug={professionSlug}`, mirrored in
`trainerReducer.task`:
`{id, lesson_id, description, panes[] (starter code), answer_panes[] (⚠️ the author's
reference solution, sent to the browser), hints[], success_message, solved, position,
is_chain, skip_check, assessment_tree, sharing_url, …}`.

**`check_task` 200 response:**
```json
{"run_result":{"exit_code":0,"stdout":"","stderr":"","timeout":false},
 "test_result":{"exit_code":0,"stdout":{"solved":true,"timeout":false,"error":null},"stderr":"","timeout":false},
 "attempt_id":214452746}
```
For a wrong solution the result panel showed the program's stdout plus the checker
message (e.g. *"Убедитесь, что в функцию sqlite3.connect() в качестве аргумента
передана строка db.sqlite."*). The exact JSON for a failed check wasn't captured.
The message is most likely in `test_result.stdout.error`.

**State transitions** (as seen in Redux and the DOM):

| Step | URL | State / UI change |
|---|---|---|
| theory lesson → "Перейти к заданию" (`tid=next-lesson-control-button`) | `/learn/…` → **full load** `/trainer/{slug}/lesson/{lessonId}/task/{taskId}/?hideTheory=1` | `PATCH subscriptions/{subId}/current_lesson/` |
| check fails | same | result panel shows stdout + checker message; `attemptsInLesson`++ |
| check passes | same | `task.solved=true`, `lesson.tasks[i].solved=true`, result panel shows `success_message`, button **"Далее"** (`tid=next-task-button`) appears, `attemptsInLesson` reset |
| "Далее" | SPA → `/trainer/…/task/{nextTaskId}/` | `GET /api/tasks/{id}/`; editor **replaced by the new task's starter `panes`**; "Предыдущее задание" button appears |
| last task passes | same | additionally `lesson.solved=true` (no separate `/solve/` call); `next-task-button` text = **"Следующий урок"** |
| "Следующий урок" | SPA → `/trainer/{slug}/lesson/{nextLessonId}/` (theory, inside the trainer app) | `checkin` of the next lesson, `PATCH current_lesson`; no feedback screen in between |

Each task is checked in isolation. Task 2's starter code already re-opens `db.sqlite`,
and task 3's starter code contains the data list and `commit()/close()`, so the model
only has to fill in the missing part.

### 5b. `web_server` trainer (Django project with live preview)

Inspected on «Словарь контекста, ветвление и циклы в шаблонах» (sprint 4, «Основы
веб-разработки»). The exercise: write by hand the HTML a Django template would render.
Not solved, only deployed.

- `lesson.coderun_config = {"docker_image":"django5-server"}`, `fs_mode: "enabled"`.
- **Multi-file project:** `task.panes` holds all 38 project files (`manage.py`, apps
  `about/`, `ice_cream/`, `homepage/`, `anfisa_for_friends/settings.py`, `templates/**`).
  The pane with `opened: true` is the one shown (`templates/homepage/index.html`). Only opened
  files get a Monaco model (`file:///templates/homepage/index.html`).
  `answer_panes` contains the **whole reference project** (⚠️ leak, as in §5a).
- File tree in the DOM: `.files-tree` → `.tree-node` / `.tree-node__name` (folders collapse
  via react-slidedown). Opening a file creates or switches the Monaco model.
- Buttons: `tid=deploy-button` "Задеплоить", `tid=check-task-button` "Проверить",
  `tid=web-result-refresh-button` "Обновить", `tid=trainer-hint-button`, "Скачать проект",
  "Начать заново", "Во весь экран", "Развернуть/Свернуть".

**Deploy flow ("Задеплоить"):**

| Step | Request | Notes |
|---|---|---|
| (re)deploy | `DELETE /api/servers/{oldId}/` (if one exists), then `POST /api/servers/` | request body not captured (BiDi `postData` unavailable); most likely the panes |
| state | `trainerReducer.webserver = {id, container_hash, server_ip, running, url, last_activity, session_id, hostname}`, `runWebserverLoadingStatus:"SUCCESS"`, `isCodeChanged:false`, `originalIframeLink`, `resultIframeTitle` | |
| preview | iframe `.trainer-result__content` → `https://{id}.serverhub.praktikum-services.ru/staticfiles/frame.html?v=4.0.7&language=ru`, which loads `https://{id}.serverhub.praktikum-services.ru/` | **public**: a plain GET without cookies returns the rendered page |
| logs | websocket `wss://serverhub.praktikum-services.ru/servers/{id}/tools/logs/` | Django runserver logs (not read yet) |

Observation: Django template tags **inside an HTML comment still run** (the comment is
literal text for the template engine). With this view's empty context the commented
loop rendered its `{% empty %}` branch.

Tool implications: `list_files()`, `read_file(path)` (from `task.panes`),
`write_file(path, content)` (open the file via the tree, then Monaco), `deploy()`, and
`fetch_preview(path="/")` (plain GET of `webserver.url`), plus `check_task()`.

**Check flow ("Проверить"), stage 1 solved** (timings from `watch-state.mjs --click`):

| t | Event |
|---|---|
| 0 s | click; **"Проверить" and "Задеплоить" get `disabled`** (greyed) and the preview shows a spinner |
| 1.4 s | `DELETE /api/servers/{old}/`, so **check always redeploys the current code** |
| 12.7 s | `POST /api/servers/` (new server), preview `frame.html`, logs websocket (101) |
| 17.9 s | `POST /api/backend/check_web_server_task/{taskId}/` → 200 |
| 18.4 s | `POST /api/tasks/{taskId}/solutions/` → 201 (solution saved), `PATCH …/current_lesson/` |
| after | buttons enabled again; `trainerReducer.playgroundResponse = {"test_result":{"status":"ok","message":"","solved":true},"run_result":null,"attempt_id":…}`; `task.solved=true`; success **banner** above the task description, `div.notification.notification_type_success.trainer-footer__message` inside `.messages-container__web_server` (text = `success_message`); `tid=next-task-button` "Далее" appears in the footer |

How a tool knows a check is running and when it's finished:
- running: `[data-test-id="check-task-button"]` has `disabled` (same for `deploy-button`);
- finished: the button is enabled again **and** `playgroundResponse` changed (has a new
  `attempt_id`). `playgroundResponse.test_result.{status, message, solved}` is the
  verdict, and `message` is presumably the checker's explanation on failure.
- The whole cycle takes about 20 s even when it works. Allow ≥ 60 s before declaring a timeout.

Success signals for a tool, any of these: the `notification_type_success` banner, the `next-task-button`,
`task.solved === true`, or `playgroundResponse.test_result.solved`. A failed check presumably
shows `notification_type_error` (not observed yet).

**Preview frame and terminal.** The preview pane is a separate cross-origin app ("feynman",
`webpackChunk_yandex_practicum_feynman_static`, not React) at
`https://{id}.serverhub.praktikum-services.ru/staticfiles/frame.html`, nesting the
student site in `blank.html`. Its footer has **"Терминал"**: an **xterm.js** panel
(`.feynman-footer__terminal .xterm-rows`) streaming the Django server log from the logs
websocket (migrations, `"GET / HTTP/1.1" 200 …`, tracebacks would appear here).
The main page can't read it (cross-origin). The extension needs a content script with
`all_frames: true` matching `*.serverhub.praktikum-services.ru`, or it can open the logs websocket itself.
→ tool `read_server_log()`.

Failure seen: one attempt ended with **"Неизвестная ошибка, код 408.previewTimeout"** in
the preview pane (the preview server didn't come up in time; platform instability), so retry.
Request bodies for `servers/`, `check_web_server_task` and `solutions` aren't captured
(BiDi exposes no POST bodies here).

---

### 5c. Platform AI chat ("Практикум ИИ")

Tested on the `web_server` trainer page (one question asked, about `forloop.counter`).

**UI**

| Element | Selector | Notes |
|---|---|---|
| open/close toggle | `[data-test-id="sidebar-gpt-button"]` (sidebar "ИИ" icon) | panel is `.ai-chat__dnd` (draggable); hidden state = `.ai-chat__dnd_hidden` (0×0). The first click only loaded onboarding and the second one opened it, so check `isChatOpened`, don't assume |
| input | `textarea.ai-chat__input` (placeholder "Спросите что-нибудь...") | React `onChange` + `onKeyPress` (Enter probably sends) |
| send | `[data-test-id="ai-chat-submit"]` | |
| new chat / close | `[data-test-id="yagpt-refresh-button"]`, `[data-test-id="yagpt-close-button"]` | |
| suggested questions | `button.ai-chat__scroll-to-suggestions-button` "Часто спрашивают в этом проекте" | the list itself is in state `suggestions[]` |

**State** (`chatYaGPT.aiChatReducer`): `isChatOpened`, `isLoading`, `chatId` (null until the
first question), `messages[]` (`{type: "onboarding"|"user"|"ai", text, messageId?,
isStreaming?, tempId}`), `inputValue`, `suggestions[{id,text}]`,
`suggestionGenerationId`, `pendingStreamRequest`. Onboarding says the assistant can explain
topics, summarise the lesson, help with homework and find bugs, but can't follow links or
read images.

**Network**

| t | Request | Response |
|---|---|---|
| 0 s (send) | `POST /api/gpt/stream/ask_in_lesson/` (`accept: text/event-stream`, JSON body, cookie auth) | 200 `text/event-stream`: 57 events `data: {"type":"ask_in_lesson","chat_id":3743326,"response":{"text":"<chunk>","streaming":true}}`; the answer arrived in ~2 s |
| +9 s | `POST /api/gpt/suggestion/` (header **`x-authtoken: <JWT>`**) | `{"suggestions":[{id,text}×3],"chat_id":…,"suggestion_generation_id":…}` |
| page load | `GET /api/gpt/chats/?lesson_id=…&scenario=lesson_question` | existing chats for the lesson (empty before) |

The request body of `ask_in_lesson` wasn't captured (BiDi doesn't expose POST bodies).
**Per the user, it isn't needed:** the adapter drives the UI instead of calling the API.

**Adapter: "ask the platform model" by emulating input** (planned `ask_platform_ai(question)`):
1. If `!aiChatReducer.isChatOpened`, click `sidebar-gpt-button` and wait until it's true.
2. Put the text into `textarea.ai-chat__input` so React sees it (real key events from
   the extension, or the native value setter + `input` event), then click `ai-chat-submit`.
3. Wait until `isLoading === false` and the last message is `{type:"ai", isStreaming:false}`
   (streaming progress = that message's `text` growing). Return its `text` (Markdown).
4. Optionally return `suggestions[]` as follow-up options.
The chat is tied to the current lesson (`ask_in_lesson`, `chat_id`), so the platform
model already has the lesson as context. Answers are in Russian Markdown with code blocks.

---

## 6. Interactive elements → planned tools

"Semantic" means the tool reads the store or calls the API. "DOM" means it clicks
like a user. The plan is semantic first, with DOM as the fallback.

| Element | Where / how to find it | Planned tool | Effect |
|---|---|---|---|
| Course card | `/profile/…`, `button.course-card` | `list_courses()` (API `subscriptions/{id}/courses`) | read |
| Course modal → topic → lesson | `div.skills-modal`, `a.link` | `list_lessons(course)` (progress API / lesson chain) | read |
| Lesson link / sidebar | `a[href^="/learn/"]` | `open_lesson(lessonId)` → `history.push` | **checkin** |
| Lesson text incl. hidden parts | Redux `lesson.theory` | `read_lesson()` → Markdown with block ids | read |
| `ActionButton` | `[data-test-id="theory-action-button-<blockId>"]` | `press_action(blockId)` | writes |
| `CutContainer` | `section.theory-viewer__block_type_cut-container button` | none (content is already in `read_lesson`) | none |
| `QuizSelect` checkbox/radio | `label:has(input[value="<optionId>"])` + `form … button[type=submit]` | `answer_quiz(blockId, optionIds)` | writes, **single attempt** |
| `QuizChoice` / `QuizCards` / `QuizText` / `QuizMacaroni` | theory blocks | `answer_quiz(blockId, …)`, payload format **still to be observed** | writes |
| `QuizFeedback` | survey | leave to the user | writes |
| Next lesson / "Перейти к заданию" | `[data-test-id="next-lesson-control-button"]` | `complete_lesson()` | **marks solved** + navigates |
| Trainer task text + hints | `trainerReducer.lesson.tasks[]` (`description`, `hints[]`) | `get_task()`, `get_hint()` (hints are client-side, no API call) | read |
| Monaco editor | `monaco.editor.getModels()[0]` | `get_code()` / `set_code(code)` | draft (persists across reloads) |
| "Выполнить код" | `button[aria-label="Выполнить код"]` | `run_code()` | run |
| "Проверить" (trainer) | `[data-test-id="check-task-button"]` | `check_task()` → `{solved, message}`; retry on 400 | attempt |
| "Далее" / "Следующий урок" | `[data-test-id="next-task-button"]` | `next_task()` | navigates; on the last task opens the next lesson (checkin) |
| "Предыдущее задание" | button text | `prev_task()` | navigates |
| "Начать заново" | button text | `reset_task()` | **not probed** |
| Platform AI chat | `sidebar-gpt-button`, `textarea.ai-chat__input`, `ai-chat-submit`, slice `chatYaGPT` | `ask_platform_ai(text)` (see §5c) | creates a chat on the account |
| Lesson/quiz rating thumbs | `*-thumb-up/down-rated-false` | none | writes |

---

## 7. What was done on the account during inspection

- Lessons 1–4 of "Введение в базы данных" (sprint 5, «База данных и Django ORM»):
  checked in and **marked solved** via "К следующему уроку".
- Lesson 1: both action buttons pressed.
- Lesson 2: quiz 1 answered **deliberately wrong** (one attempt, now locked); quiz 2 answered correctly.
- Lesson 3: radio quiz answered correctly.
- Lesson 5 (trainer): several check/run attempts with deliberately wrong code, then
  **all three tasks solved** (my own solutions), so lesson 5 is solved.
- Lesson 6 ("Получение данных") opened inside the trainer app (checked in, not solved).
- Sprint 4 «Словарь контекста, ветвление и циклы в шаблонах» (`web_server`): several deploys;
  **stage 1 of 3 solved** (hand-written HTML for the template loop). Stages 2–3 untouched.
- Navigation checks: switched profession to «Мягкие навыки» and back; re-opened lesson «Словарь контекста…» (extra checkins, nothing solved).
- Gap checks: opened `homepage/views.py` in the Django trainer; opened and cancelled the reset dialog; **dropped AI chat 3743326** via "new chat" (and cleared the suggestion it put in the input); ran lesson 5 task 3 with a temporary `print` and restored the original code; search returned 503.
- Git topic (after the user's topic reset): «Практика по теме» 3 quizzes answered and **lesson solved** (the «К следующей теме» press happened in an interrupted run); «Работаем с Git»: Macaroni, radio self-check ("Да, капитан!", answered on the user's behalf), QuizChoice, all answered, lesson not yet solved.
- «Основы промт-инжиниринга» (already solved): QuizCards retried and re-answered 9/9 (was 8/9).
- Sprint 14 «Обратная связь» survey: filled in and submitted **by the user** while recorded.
- «Протокол HTTP…» (sprint 4): QuizText answered "404" (verified with curl first), correct.
- Asked Практикум ИИ one question in that lesson, which created chat `3743326`.
- 2026-10-15, live tests of the extension tools (each approved by the user in the page overlay):
  «Работаем с Git» q3 (QuizChoice) re-submitted with the same answer (`attempts_count` now 3, one try
  aborted before any click); «Основы промт-инжиниринга» QuizCards re-submitted with the same grouping
  (9/9); **«Работаем с Git» marked solved** via `complete_lesson`. Lessons opened by `open_lesson`
  (extra checkins): «Работаем с Git», «Основы промт-инжиниринга», «История изменения кода» (by the next button).
- Trainer tool tests (same day): «Работа с базой данных из Python» (6.1.5): `run_code` with a temporary
  `print` then the original code restored, `set_code` with identical code, tasks 1→2→1, **one extra
  `check_task` attempt on solved task 1** (approved; attempt 214457099, solved). «Словарь контекста…»
  (5.4.3), stage 2 (unsolved): opened `ice_cream/urls.py` and rewrote it with identical content, one
  deploy, preview pages fetched. Nothing checked there. Then, approved: `ask_platform_ai` asked one
  question in that lesson's chat («Как в шаблоне Django обратиться к значению словаря по ключу?»).
- Verification of the remaining tools on unsolved lessons (asked for by the user, each approved):
  6.1.6 «Получение данных» q1 radio → «Выборка будет пустой» (correct); 7.1.10 «Валидация формы» q1
  button «Готово» pressed, q2 free text «ACDB» (correct); 7.3.1 «Работа с пользователями в Django» q1
  connect-the-items 1=B, 2=A (correct). 5.4.3 stage 2 (Django): one check of the unchanged code (failed,
  attempt 214457516), one check whose edit hadn't reached the platform (failed, 214457560, see §8),
  then **solved** (214457608) with `context = {'ice_cream': ice_cream_catalog[pk]}`. One more
  Практикум ИИ question there («Что делает тег {% empty %}…»). None of these lessons were completed.
- Code-block tools (`QuizCoding`), «Типизация и типы данных» (2.1.3, already solved): example q1 run
  once by a probe and once by the tool (it raises a TypeError on purpose), example q2 run with replaced
  code (`print(2 ** 10, 7 // 2, 7 % 2)`, after several backend timeouts), graded q8 reset twice (one
  probe reset cancelled) and **re-checked with `print(int(x) + int(y))`: solved**. Two page reloads at
  the user's request (backend timeouts).
- Практикум ИИ agent runs (each chat message and action approved by the user): 2.1.3 one tool-list
  test (2 rounds); «Создание и клонирование репозиториев» q1 answered 1 (correct) and **completed**;
  «Отслеживание файлов проекта» **completed by a blind batched `complete_lesson`** without its tasks
  being read; «Игнорирование отслеживания файлов проектов»: action button q1 pressed, its AI chat
  **reset** (new chat), chat quiz question 1 answered 3 (correct), «Далее» not yet pressed.

Quiz answers were chosen by reasoning about the question, not by reading the leaked key.

---

## 8. Gotchas and open questions

- **The trainer backend fails often.** `check_task` / `run_code` intermittently return
  `400 {"code":"PY.check_task","message":"Failed to parse AstOutput … EOF"}`, and the UI
  shows "Неизвестная ошибка 400.py.checkTask". The same request succeeds on a later try
  (e.g. 3 failures then 200, without wrapping `fetch` or reloading). Per the user, this is
  platform instability (infrastructure damage). → `check_task` / `run_code` tools need
  **retry with backoff**, and must report "platform error, retrying" separately from
  "solution wrong".
  (Earlier I suspected my `fetch` wrapper (`recorder.mjs`) caused this. That's not
  supported: failures happened without it too. Still, observing traffic from the
  extension background with `webRequest` / `filterResponseData` is cleaner than
  patching page globals.)
- BiDi `response.text()` **does** return bodies on Gecko 153 (used by `trainer-step.mjs`),
  so the page needs no `fetch` wrapper for inspection.
- Where trainer drafts are saved (server vs localStorage) is unknown. The draft survived a reload.
- Response formats still to capture: failed `check_task`, `run_code`, and submissions for `QuizChoice`, `QuizCards`, `QuizText` and `QuizMacaroni`.
- `web_server`: request bodies of `servers/` / `check_web_server_task/` and the logs websocket not yet observed. The shape of a failed `test_result` is also unknown. `homework_without_review` hasn't been explored.
- The profile course tree (`profileReducer.profile`) is server-rendered into `window.__preloadedState__`
  in the HTML of `/profile/{slug}/`; no API call loads it. `GET /api/v2/professions/{slug}/` returns an
  error object. Off the profile page, `get_progress` fetches that HTML and parses the state.
- Re-submitting a retryable quiz with an identical answer only changes `attempts_count` in
  `GET …/quizzes/`; tools detect "saved" by answer + `attempts_count`.
- The bottom `next-lesson-control-button` (and its label) renders ~1 s after the lesson blocks.
- The embedded `__preloadedState__` is a JS literal with bare `undefined` values, not JSON.
- Answered quizzes have `quiz_answered` on the block root; per-row results are classes ending in
  `_correct` / `_incorrect` (`quiz-form-matching__prompt_correct`, `quiz__macaroni-pin_status_correct`,
  `quiz__list-item_correct`); radio/checkbox show feedback text instead.
- **Editing a hidden editor tab is not recorded.** Each open file has its own Monaco editor; only the
  visible one's changes reach `trainerReducer.task.panes`, which is what deploy and check send. Bring
  the file's tab to the front (click it in the tree) before editing, then confirm `task.panes`.
- A failed web_server check: `playgroundResponse = {test_result: {status: "ok", message: "<checker
  text>", solved: false}, run_result: null, attempt_id}`; the page shows the message in
  `.notification_type_error.trainer-footer__message`. The check redeploys first and the buttons
  re-enable briefly in between, so wait for a new `attempt_id`.
- Quiz result marks (`…_correct` / `…_incorrect` classes) appear shortly after the answer is saved.
- Markdown blocks can contain `{quiz-task} background: | … content: | … {/quiz-task}`: a coloured note
  box, not an interactive block.
- **Практикум ИИ as the agent** (`practicum-platform-agent`): the platform chat is per lesson, so
  every page change starts a fresh chat; the driver resends the protocol, task and a log then. The
  model follows the text protocol (`CALL {...}` lines, `ANSWER:`), but tends to batch whole plans
  with invented block ids and guessed results; the driver runs at most one action per round and
  stops a batch at the first error. Chatty replies may contain example `CALL`/`ANSWER` lines in code
  fences, which are ignored.
- The AI chat's continuation endpoint `POST /api/gpt/stream/message/` intermittently fails as
  HTTP 200 + body "500 Internal Server Error"; the page rolls the message back and shows an error
  toast «Сервис временно недоступен…». `ask_platform_ai` reports it as `platform` at once; the driver
  waits 70 s and resends, then starts a new chat (ask_in_lesson) with a self-contained message.
- `QuizCoding` blocks use CodeMirror 5, not Monaco; a page reload shows the starter code again even
  for solved blocks (the solved attempt stays in `GET …/quizzes/`). Their run backend sometimes
  answers «Request took too long to execute; timeout occured» (no result panel); retrying or
  reloading helps (per the user, a load balancer may route to a dead server).
- Local agent run on «Распределение адресов по приложениям»: task 1 solved (3 checks) by gpt-oss;
  task 2 needs a new file `about/urls.py` (created by hand during inspection, empty); «View-функции:
  от запроса до ответа» task 1: 4 failed checks, its `anfisa_for_friends/urls.py` left broken.
- `trainerReducer.oldPlaygroundResponse` holds the latest serverless run **or** check result; a check
  adds `test_result` and a new `attempt_id`. `playgroundResponse` is the web_server check result.
- Monaco objects reached through `wrappedJSObject` are raw page objects: passing content-script objects
  to them (`executeEdits` edit lists, `scrollIntoView` options on `getDomNode()`) needs `cloneInto` or
  re-wrapping with `XPCNativeWrapper`.
- Saved quiz answers are matched by `content_quiz_id` = the block's **`content.id`** (`expander-{content.id}`
  for action buttons), while the submit request's `id` is the block's **node id**.
- Socket.io (`connectSocketIONamespace`, `serverhubWsUrl`): purpose unknown (probably notifications/chat).
