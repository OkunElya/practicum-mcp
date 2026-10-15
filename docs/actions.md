# Interactive actions catalogue

Every user-facing action found on practicum.yandex.ru during inspection. This is the
input for tool design. Details, payloads and selectors' context are in
[platform-findings.md](platform-findings.md).

**Effect**: `read` (no change) · `nav` (navigation; opening a lesson also sends a
`checkin`) · `rev` (reversible change, e.g. editor draft) · `irrev` (recorded on the
account and can't be undone: quiz answers, solved status, new AI chat).

**Status**: ✅ performed and observed · 👁 element seen, action not performed · 📄 known only
from lesson data (block type), never rendered or submitted.

---

## A. Navigation and progress

Page transitions: profile ⇄ theory lesson ⇄ trainer are **full page loads** (separate
bundles; content scripts restart). Lesson → lesson inside `/learn/` and task → task
inside `/trainer/` are SPA navigations.

| # | Action | Where | How (locator / API) | Done when | Effect | Status |
|---|---|---|---|---|---|---|
| A1 | Go to the main (profile) page | theory lesson | `[data-test-id="sidebar-home-button"]` "В профиль" (`<a href="/profile/{slug}/">`), full page load. **On the trainer the same test-id is "Назад к уроку"** and goes to the theory lesson (full load + checkin). From the trainer it takes 2 steps, or set `location` to `/profile/{slug}/` | URL `/profile/{slug}/`, `profileReducer.getProfileLoadingStatus = "SUCCESS"` | nav | ✅ |
| A2 | Switch profession | any page header | `[data-test-id="users-courses-select-toggle"]` "Мои курсы" opens a dropdown of `a.users-courses-group__item-link` (`href=/profile/{slug}/?from=…`, current one `…_active`). Esc does **not** close it; clicking the toggle again does | URL `/profile/{otherSlug}/` | nav | ✅ (switched and back) |
| A3 | Read overall progress | profile | **Source of truth:** `profileReducer.profile.courses[] → topics[] → lessons[]`, each with `solved` (lessons also have `lesson_type`, `is_homework`, `homework_status`, `has_access`, `completion_time`). UI: `button.course-card` text has "Пройден" when the course is solved; bar `.course-progress__line` width = % (looks **time-weighted**: База данных 15 % vs 5/36 lessons, Flask ≈14 % vs 9/26). The top "Прогресс по курсу" bar (`.profile-overview__progress-bar`) is `_disabled` here. RTK `getProgressGoal(slug)` = `{progress, goal}` (looks like a weekly goal). Notifications: `.prisma-notifications-list` / `GET /api/notifications/` | — | read | ✅ |
| A4 | Open a course (sprint) | profile | `button.course-card` containing the course name (scroll into view first) | `.skills-modal.skills-modal_visible` exists. **Don't** use "any `.skills-modal`": about 25 empty full-screen ones are always mounted | read | ✅ |
| A5 | Open a topic | course modal | `.skills-modal_visible a.link` without `href` → tab "Тема" becomes active and lists lessons `a.link[href]` | lesson links visible | read | ✅ |
| A6 | Switch modal tab "Курс" / "Тема" | course modal | `.skills-modal_visible section.tab` by text; the active one has class `…active` | tab active | read | ✅ |
| A7 | Close the modal | course modal | Escape ✅, or `.skills-modal_visible svg.icon-cross.modal-content__close-wrapper` ✅ | no `.skills-modal_visible` | read | ✅ |
| A8 | Open a lesson | modal / lesson sidebar | `a.link[href^="/learn/{slug}/courses/…/lessons/{id}/"]` (from the profile modal: full page load) | `proficiencyReducer.lesson.id` = target | nav (checkin) | ✅ |
| A9 | Browse the program inside a lesson | theory lesson | sidebar `header.sidebar__topic-header` shows **"done/total"** per topic (e.g. "HTML и шаблоны Django 0/9"); clicking it expands/collapses that topic's lesson links ✅. `[data-test-id="sidebar-navigation-button"]` "Программа" did **not** hide the sidebar on a wide window. Lesson status = class on `a.sidebar__lesson`: `sidebar__lesson_status_solved` (black tick), `…_status_reset` (grey tick: solved before a topic reset, must be redone), `…_status_solved-twice` (blue double tick: solved again after reset), plus `sidebar__lesson_current`, `sidebar__lesson_available` | links visible | read | ✅ |
| A10 | Read topic/lesson progress | lesson | API `GET /api/progress/lesson/{lessonId}/?sprint_id=` → topic lessons with `solved`, `next_topic`, `course`, `sprint` ✅. UI: breadcrumb `.current-lesson-path__hint` "Спринт 5/16 → Тема 1/6 → Урок 1/10" (not on every lesson), segmented progress bar, sidebar counts (A9) | — | read | ✅ |
| A11 | Finish theory lesson and go next | theory lesson | `[data-test-id="next-lesson-control-button"]` "К следующему уроку" → `POST /api/lessons/{id}/solve/` → next lesson | URL = next lesson, previous `solved` | **irrev** (marks solved) + nav | ✅ |
| A12 | Go to the lesson's practice | theory lesson of a trainer type | same test-id, text "Перейти к заданию" → **full page load** `/trainer/{slug}/lesson/{id}/task/{taskId}/` | trainer loaded (`trainerReducer.task`) | nav | ✅ |
| A13 | Next / previous task | trainer | `[data-test-id="next-task-button"]` "Далее" (after a task is solved); previous = **icon button** `button[aria-label="Предыдущее задание"]` in the task header (no text) | URL `/task/{id}/` changes, editor gets new starter code | nav | ✅ |
| A14 | Next lesson from the trainer | trainer, last task solved | `next-task-button` with text "Следующий урок" → `/trainer/{slug}/lesson/{nextId}/` (theory shown inside the trainer app) | URL changes | nav (checkin) | ✅ |
| A15 | Trainer: show theory / back to lesson | trainer | `[data-test-id="sidebar-theory-button"]` "Теория" (toggles theory pane); `sidebar-home-button` "Назад к уроку" (see A1) | — | read / nav | 👁 / ✅ |
| A17 | Reset ("пройти заново") a solved topic | theory lesson sidebar | only on **fully solved** topics: `header.sidebar__topic-header span.sidebar__topic-reset` → `section.sidebar__topic-reset-content` (refresh icon) → `handleTopicReset({topic, courseId, sprintId})` → confirm dialog, confirm = `[data-test-id="confirm-modal-confirm-button"]` "Пройти заново" (performed by the user; request not recorded) | topic lessons become `solved:false`, `lesson.has_been_reset:true`, **quiz answers cleared** (`GET …/quizzes/` → `[]`), quizzes answerable again | **irrev** (loses solved status) | 👁 handler read, user performed it |
| A16 | Search course materials | any page header | `[data-test-id="header-search-button"]` opens a modal (`.prisma-modal__content .search__ru`) with `input.search__ru-input` ("Искать в материалах курса...") plus suggestions/history; Enter → `GET /api/search/profession_content/?profession_slug={slug}&query={q}` | results list (format unknown) | read | ⚠️ flow ✅, but the backend returned `503 {"code":"Search.SAASIsUnavailable"}` (~8.5 s) on every try, so there's no result format |

## B. Reading content (no UI needed)

| # | Action | Source | Effect | Status |
|---|---|---|---|---|
| B1 | Read the current lesson (all blocks, including ones hidden behind buttons or quizzes) | Redux `proficiencyReducer.lesson.theory` / `trainerReducer.lesson.theory`, or `GET /api/lessons/{id}/` (no checkin) | read | ✅ |
| B2 | List lessons of a course/sprint | follow `next_lesson_id` via `GET /api/lessons/{id}/`, or the progress API (A10) | read | ✅ |
| B3 | Read a trainer task (description, starter files, hints, success message) | `trainerReducer.task` / `GET /api/tasks/{taskId}/?slug=` | read | ✅ |
| B4 | Previous answers in a lesson | `GET /api/lessons/{id}/quizzes/` | read | ✅ |

Hidden-dialog trap: confirm buttons such as `confirm-modal-confirm-button` stay mounted (and have a bounding box) inside closed `.skills-modal` elements. Only act on them inside `.skills-modal_visible`.

Leaks to strip before showing the model: quiz `correct*` / `validations` / `correct_answers` / `result_text`, task `answer_panes`.

## C. Theory lesson interactions

| # | Action | Locator | API / result | Effect | Status |
|---|---|---|---|---|---|
| C1 | Press an action button (`ActionButton`) | `[data-test-id="theory-action-button-{blockId}"]` | `POST /api/lessons/{id}/quizzes/` `{user_answer:true, markup:{id:"expander-{content.id}",type:"actionButton"}}`; following blocks and a `Dialog` appear | irrev | ✅ |
| C2 | Answer a checkbox quiz (`QuizSelect` type `checkbox`) | `label:has(input[value="{optionId}"])` per option, then `form:has(…) button[type=submit]` "Проверить" | `POST …/quizzes/` `{id:blockId, user_answer:[optionIds], markup}`; quiz locks (`quiz_answered`), per-option feedback shown, following content unblocked | **irrev, single attempt** (only a topic reset, A17, re-opens it) | ✅ (wrong and right) |
| C3 | Answer a radio quiz (`QuizSelect` type `radio`) | same as C2 with one option | same | **irrev, single attempt** | ✅ |
| C4 | Match prompts to options with dropdowns (`QuizChoice`; also used for "put in order" with prompts "1.", "2.", …) | block `.quiz_type_choice` → `.quiz-form-matching`, one `.quiz-form-matching__prompt` per question with a custom dropdown `button.rich-select__toggle-wrapper` ("..."); the menu opens in a portal `.rich-select__menu-portal [role=listbox]` with `button.rich-select__item[role=option]` (option text); then `.quiz_type_choice button.button2` "Проверить" | `POST …/quizzes/` `{id: blockId, user_answer: {questionId: optionId, …}, markup}`; green/red per row; **"Начать заново" button appears, so it can be retried** | irrev (retry possible) | ✅ |
| C5 | Sort cards into groups (`QuizCards`) | block `.quiz_type_cards`: pool = `.dragndrop__list_orientation_horizontal`; columns = `.quiz__section-list-wrapper` (title `.quiz__section-content-text`, list `.dragndrop__list_orientation_vertical .dragndrop__list-content`), inside a horizontal slider (`slider__content`, arrows `svg.icon-prev/.icon-next` on narrow screens). **Click-based, no drag needed:** click a card `.dragndrop__item` (gets `quiz__list-item_selected`), then click the column's list. Each card has a "Подсказка" (`.quiz__feedback-button`). "Проверить" = `.quiz_type_cards button.button2` with that text | `POST …/quizzes/` `{id: blockId, user_answer: {"source": [], "<sectionId>": [optionId, …], …}, markup}`; cards get `quiz__list-item_correct/_incorrect`, `[role=status]` "Правильных ответов: N, неправильных: M…". **Retryable:** `button.quiz__reset` "Ответить повторно" → inline `.quiz__reset-dialog` "Начать тест заново?" "Заново"/"Отмена" → cards back to the pool (client-side only) | irrev (retry possible) | ✅ |
| C6 | Free-text answer (`QuizText`) | block `.quiz_type_text`: `textarea.input__control.quiz__input-control` (React `onChange`, so type real keys or use the native setter + `input` event), then `button.prisma-button2` "Проверить" (disabled while empty) | `POST …/quizzes/` `{id: blockId, user_answer: "<text>", markup}` → 201. Graded in the browser against `validations[]` (`type: "strict"` exact match or `"regexp"`). Then the textarea is **removed**, the block shows "Ваш ответ правильный" (or the failure text) + the answer + `result_text`; no retry button | **irrev, single attempt** | ✅ |
| C7 | Connect left↔right items (`QuizMacaroni`) | block `.quiz_type_macaroni`, two `.MarkerMacaroni-List` columns of `label.Option` (hidden checkbox `value` = **original index**, columns shuffled when `shuffle_left/right`). Click a left label (gets `Option_checked`), then a right label: a line is drawn (`g.MarkerMacaroni-Line[role=button]`) and both checkboxes reset, so the pairing lives in React state. "Проверить" (`.quiz_type_macaroni button`) enables once every left item is connected | `POST …/quizzes/` `{id: blockId, user_answer: [[leftIdx, rightIdx], …], markup}` using unshuffled indices; result: green ticks per pin, a "?" explanation per left item, lines become `Line_disabled`. Button text can also be "Узнать ответ" | **irrev, single attempt** | ✅ |
| C8 | Sprint feedback survey (`QuizFeedback`), the last lesson «Обратная связь» of a sprint | block `.quiz_type_feedback`, 3 slides with pager "1 — 3". Slide 1 = Likert grid `.likert-scale`: rows `.likert-scale__statement-row`, 25 radios `input.radio__input` (`name` = statement id, `value` = grade id; grades нет/скорее нет/не знаю/скорее да/да = −2…2, some statements `isInverted`); `button.button2` "Далее" disabled until every row has a grade. Slide 2 = free text (placeholder "Можно писать про всё…"). Slide 3 = "Спасибо за ответы!…" | **one** `POST …/quizzes/` after the last slide: `{id: blockId, user_answer: {"<likertSlideId>": {"<statementId>": "<gradeId>", …}, "<textSlideId>": "<text>"}, markup}` → 201, `attempts_count: 1`; block becomes `quiz_answered`, then "К следующему уроку". Answers are the user's personal opinion, so **the tool collects them from the user, never invents them** | irrev | ✅ (filled by the user, recorded) |
| C9 | Expand a collapsible section (`CutContainer`) | `section.theory-viewer__block_type_cut-container button` | none; content already in B1 | read | ✅ |
| C10 | Download link (`ActionLinkButton`) | — | plain link | read | 📄 |
| C11 | Code block inside a theory lesson (`QuizCoding`) | block `.quiz_type_coding` with its own **CodeMirror 5** editor (`.CodeMirror` → `.CodeMirror` instance, `setValue`/`getValue`). Two kinds: **examples** (`use_tests: false`) with only «Запустить код» (text button); **graded** (`use_tests: true`, usually `blocking`, `hint`) with `quiz-coding-run-code-button` (icon "Выполнить код"), `quiz-coding-check-code-button` «Проверить», «Подсказка» (`.quiz__coding-footer-assistive-button`). Reset: `quiz-coding-reset-code-button` → inline «Начать заново? … Задание вернется в исходное состояние» with `button.quiz__reset-dialog-btn` «Да»/«Отмена» | status `theoryBlocksReducer.runCodingQuizLoadingStatus` / `checkCodingQuizLoadingStatus` (`LOADING` → `SUCCESS`/`FAILURE`); output `.quiz__code-run-result-stdout` (`…-stdout-content_error` for tracebacks); verdict banner `.quiz__coding-notification-container.notification_type_success|error`; saved `user_answer: {panes, run_only, test_result: {stdout: {solved, error}}}` (a run of an example saves `run_only: true`). Backend timeouts show «Request took too long to execute; timeout occured» in the block instead of a result. Reset keeps the recorded solved attempt | run: rev · check: irrev (retryable) · reset: asks | ✅ run, check, reset, hint |

## D. Code trainer, `serverless` (Python)

| # | Action | Locator | API / result | Effect | Status |
|---|---|---|---|---|---|
| D1 | Read / replace code | `monaco.editor.getModels()[0]` (`file:///main.py`), write via `editor.executeEdits` | draft persists across reload | rev | ✅ |
| D2 | Run code without checking | `button[aria-label="Выполнить код"]` | `POST /api/serverless/run_code/` `{task_id, panes}` → stdout in the result panel `section.trainer-result__desktop` and in `trainerReducer.oldPlaygroundResponse.run_result.{exit_code, stdout, stderr, timeout, oom_killed, duration}`; task/solved untouched. Frequent `400.py.runCode` (3 of 4 tries), so retry | rev | ✅ |
| D3 | Check the solution | `[data-test-id="check-task-button"]` | `POST /api/serverless/check_task/{taskId}/` `{panes}` → `{run_result, test_result:{stdout:{solved,error}}}`; fail = result panel with stdout + checker message; pass = `task.solved`, `success_message`, `next-task-button`; last task also sets `lesson.solved`. Retry on `400 PY.check_task` | irrev (attempt, solved) | ✅ (fail and pass) |
| D4 | Show hint | `[data-test-id="trainer-hint-button"]` | no API; hints are in `task.hints`; opens the slide-up panel `.trainer-multilevel-hint` (close: `trainer-multilevel-hint__close-btn`) | read | ✅ |
| D5 | Reset code ("Начать заново") | button text (no test-id) → confirm dialog `.trainer-taks__confirm-modal.skills-modal_visible`: "Вернуть исходный код? Сделанные вами изменения будут отменены. Задание вернется в исходное состояние." with `[data-test-id="confirm-modal-confirm-button"]` "Да, начать сначала", `…-cancel-button` "Отмена", `…-close-button` | on confirm, replaces the code with the starter `panes` (handler `onConfirm → reset(task.id)`). Effect on `solved` not tested (only cancelled) | rev (code) | ✅ dialog, confirm not pressed |
| D6 | Next / previous task | see A13 / A14 | | nav | ✅ |

## E. Code trainer, `web_server` (Django project with preview)

| # | Action | Locator | API / result | Effect | Status |
|---|---|---|---|---|---|
| E1 | List / read project files | `trainerReducer.task.panes[]` (`name`, `content`, `opened`) | — | read | ✅ |
| E2 | Open a file in the editor | file tree: `.tree-node` nesting gives the path (`homepage/views.py`); click its `.tree-node__name` | new Monaco model `file:///{path}` **and a separate Monaco editor instance** (only the active one visible), new editor tab `.tab__text`, tree item `…__name_active`. Write via the editor whose model URI matches, not `getEditors()[0]` | read | ✅ |
| E3 | Edit the opened file | Monaco `executeEdits` on that model | draft | rev | ✅ |
| E4 | Deploy | `[data-test-id="deploy-button"]` "Задеплоить" | `DELETE /api/servers/{old}/`, `POST /api/servers/` → `trainerReducer.webserver.{id,url,running}` | rev | ✅ |
| E5 | Read the rendered site | `GET {webserver.url}{path}` (public, no auth) | HTML | read | ✅ |
| E6 | Refresh the preview | `[data-test-id="web-result-refresh-button"]` | — | read | 👁 |
| E7 | Read the server log ("Терминал") | preview frame (cross-origin `…serverhub…/staticfiles/frame.html`): footer "Терминал" → xterm `.xterm-rows` | log websocket `…/servers/{id}/tools/logs/` | read | ✅ |
| E8 | Check the solution | `[data-test-id="check-task-button"]` | redeploys, then `POST /api/backend/check_web_server_task/{taskId}/`, `POST /api/tasks/{taskId}/solutions/`; while running both buttons `disabled`; result in `playgroundResponse.test_result.{status,message,solved}`; pass = banner `.notification_type_success` + "Далее". Retry on `408.previewTimeout` | irrev | ✅ (pass + 408) |
| E9 | Download the project | "Скачать проект" | zip | read | 👁 |

## F. Platform AI ("Практикум ИИ")

| # | Action | Locator | Result | Effect | Status |
|---|---|---|---|---|---|
| F1 | Open / close the chat | `[data-test-id="sidebar-gpt-button"]`; close `[data-test-id="yagpt-close-button"]` | `chatYaGPT.aiChatReducer.isChatOpened`. Sometimes takes 2 clicks, so loop until true. History is restored from the server after reload (`GET /api/gpt/chats/?lesson_id=…`) | read | ✅ |
| F2 | Ask a question | `textarea.ai-chat__input` + `[data-test-id="ai-chat-submit"]` | SSE `POST /api/gpt/stream/ask_in_lesson/`; done when `isLoading=false` and last message `{type:"ai", isStreaming:false}` | irrev (creates/extends a chat) | ✅ |
| F3 | Read suggested follow-ups | state `suggestions[]` (`POST /api/gpt/suggestion/`) | | read | ✅ |
| F4 | Use a suggested question | `.ai-chat__suggestions button.ai-chat__suggestion-button` | **only fills the input** (`inputValue`, textarea); nothing is sent until `ai-chat-submit`. `button.ai-chat__scroll-to-suggestions-button` is just a hidden (opacity 0, `pointer-events:none`) "scroll to suggestions" shortcut. Suggestions can be junk (got "Я не могу обсуждать эту тему…") | rev | ✅ |
| F5 | Start a new chat | `[data-test-id="yagpt-refresh-button"]` | `POST /api/gpt/chats/{chatId}/drop/` (204), so **the old chat is dropped** (not listed any more), then `GET /api/gpt/chats/…` → `[]` and `POST /api/gpt/suggestion/`; state `chatId:null`, `messages:[]` | irrev | ✅ |
| F7 | Rate an AI answer | `[data-test-id="ai-answer-assesment-like"]` / `…-dislike` under each answer | | irrev | 👁 |
| F8 | Save an AI answer to notes | `[data-test-id="yagpt-save-to-notes-icon-button"]` | | rev | 👁 |
| F6 | AI lesson summary | `.trainer-theory__ai-summary-button` (trainer theory pane) | `aiHelperReducer` | irrev? | 👁 |

## G. Present but not for the model

Lesson/task/quiz rating thumbs (`*-thumb-up/down-rated-false`), "Оставить отзыв",
theme switch, referral ("Подарок за друга"), support messenger ("Помощь"), notes
(`sidebar-favorites-button`), copy-code buttons, image expand/download, user menu
(contains logout and account switching).
