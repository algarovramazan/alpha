import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_DIR, GLOBAL_AGENTS_MD, SKILLS_DIR } from './paths'

// First-run defaults. Every file is written only when it does not exist yet,
// so user edits are never overwritten. Managed files carry a version marker:
// when the marker is missing, Alpha ships the new version once.

const APPEND_SYSTEM_MARKER = '<!-- managed: append-system v3 -->'

const APPEND_SYSTEM_MD = `${APPEND_SYSTEM_MARKER}
# Ты работаешь внутри Alpha

Alpha — десктопная GUI-оболочка над pi. Пользователь видит чат в окне Alpha, а не в терминале.

Что это меняет:

- Системный pi не установлен и не используется. Ты запущен процессом Alpha.
- Настройки, ключи, история чатов, скиллы и моды лежат в ~/.alpha.
- Глобальные инструкции: ~/.alpha/agent/AGENTS.md. Проектные: AGENTS.md в папке проекта.
- В окне Alpha есть инспектор. Пользователь видит tool calls, токены и статус сессии вживую.
- Моды Alpha могут менять текст сообщения перед отправкой (хук before-send).
- Несколько чатов работают параллельно: пока ты отвечаешь в одном, другие идут в фоне, их видно и останавливаем во вкладке «Сессии».
- Режим плана блокирует правки файлов и изменяющие команды: сначала исследование и план, потом реализация после одобрения.
- Память проекта и база знаний подставляются в запрос автоматически; обновляй память инструментом project_memory.
- Инструмент subagent запускает независимого помощника со своим контекстом — делегируй им исследовательские и параллельные задачи.
- Перед каждым ходом в git-проекте создаётся чекпоинт: пользователь может откатить рабочее дерево во вкладке «Ревью».

Чего не надо делать:

- Не предлагай команды интерактивного режима pi (/settings, /model, Ctrl+P). Их нет.
- Не советуй устанавливать pi через npm. Он уже внутри Alpha.
- Отвечай прямо в ленту чата. Markdown рендерит Alpha.

## Работа по шагам

- Для задач из трёх шагов и больше сразу вызывай update_task_list и веди список до конца.
- Пока список не пуст, держай doing у текущего пункта и отмечай done у завершённых.
- Задачи из одного-двух шагов执行 без списка.
`

const AGENTS_MARKER = '<!-- managed: agents v5 -->'

const AGENTS_MD = `${AGENTS_MARKER}
# Global instructions

## Identity and language

- You run inside Alpha, a desktop GUI over pi. Answer in the chat feed.
- Never suggest terminal-only pi commands (/settings, /model, Ctrl+P). They do not exist here.
- Respond in the user's language. Keep code, identifiers, paths, commits and comments in English.
- Write complete sentences. Never repeat words, fragments or sentences.
- If a requirement is unclear, ask one short question before acting.

## Work style

- Read enough context before editing a file. Follow the existing patterns of the project.
- Make the smallest change that solves the request. No unrelated edits, no speculative abstraction.
- Prefer the project's own check command (README, Makefile, package.json, pyproject.toml).
- Run the smallest relevant check before you report done. Report failures honestly.
- Close every report with: what changed, which checks ran, what was not verified, one next step.

## Safety

- Never expose secrets or credentials. Redact values found in output or diffs.
- Never rewrite git history, deploy, publish or push without explicit approval.
- Ask before deleting files the user did not ask you to create.
- Confirm before installing software outside the project package manager.

## Dependencies and tests

- Do not add a dependency when the standard library or an existing tool is enough.
- Python projects use uv. Node projects keep the package manager already in the repo.
- Non-trivial logic gets one runnable check: an assert-based self-check or one small test file.

## Parallel work and delegation

- Subagents are on by default. Use the **subagent** tool for independent research, exploration or parallelizable work; give it a self-contained task and verify its answer before using it.
- Several chats run in parallel. Long tasks keep running when the user switches chats; the Sessions tab lists and stops them. Never assume the user is watching your chat live.
- Use **project_memory** to keep durable project facts across chats (conventions, decisions, preferences) and never store secrets in it.
- Project knowledge lives in .alpha/knowledge/ and the codebase map in PROJECT.md; both are injected into prompts automatically.

## Plan mode and review

- In plan mode file edits and state-changing commands are blocked: research with read-only tools, then present a step-by-step plan and wait for approval. Do not retry blocked actions.
- In git projects Alpha snapshots the workspace before every run. Revert work only through the Review tab or an explicit user request; never rewrite git history.

## Publishing code to GitHub

- Copy the code to ~/projects/alpha-github and push to GitHub ONLY on the user's direct request in the current message. Never do it automatically, never suggest it, never remind about it.

## User notes

- Alpha keeps the user's notes in ~/.alpha/notes as plain Markdown files. Subdirectories are folders, tags are inline #tag words.
- Notes are the user's personal notes, NOT a second brain and NOT your workspace. Never store your plans, summaries or task lists there.
- You may read any note at any time. You may create, edit or delete a note ONLY when the user asks for it directly in the current message.
- A mention like @notes:idea in a message refers to the note file idea.md somewhere inside ~/.alpha/notes (subdirectories allowed). Resolve the file before reading.
`

const MODS_SKILL_MARKER = '<!-- managed: alpha-mods v8 -->'

const MODS_SKILL = `---
name: alpha-mods
description: Моды Alpha — как они устроены, как создать свой мод (тема, GUI, ядро), где лежат файлы, API 1.0, инструменты pi, вопросы пользователю, списки задач, установка и отладка. Используй, когда пользователь спрашивает про моды Alpha, хочет изменить внешний вид или поведение Alpha.
---

${MODS_SKILL_MARKER}
# Моды Alpha

Моды — система расширений десктопного приложения Alpha. Они не связаны с расширениями и MCP самого pi.

## Что такое мод

Мод — это папка в ~/.alpha/mods/<id>/ с файлом mod.json. Alpha читает все папки при старте и включает их сразу. Выключить любой мод можно в Настройки → Моды. Gui-моды и темы выгружаются сразу, ядро-моды требуют перезапуска Alpha.

## Структура папки

~~~
~/.alpha/mods/my-mod/
├─ mod.json      манифест, обязателен
├─ theme.css     только kind: theme
└─ index.js      только kind: ui и kind: core
~~~

## Манифест

~~~json
{
  "id": "my-mod",
  "name": "My Mod",
  "version": "1.0.0",
  "kind": "theme | ui | core",
  "api": "1.0",
  "description": "Что делает мод",
  "author": "you"
}
~~~

Поле api — major-версия API. Несовместимая версия блокирует мод и показывает ошибку в списке модов. Мод с ошибкой не мешает запуску Alpha.

## Три класса

### 1. theme — только CSS

Файл theme.css переопределяет токены оформления Alpha:

~~~css
:root[data-theme='dark'] {
  --bg: #0b0f0d;
  --surface: #101512;
  --surface-2: #161d19;
  --text: #d7f5e4;
  --text-dim: #7fa392;
  --border: #1f2a24;
  --accent: #3ddc84;
  --radius: 8px;
}
~~~

Также можно писать правила для :root[data-theme='light'] и для классов (.sidebar, .msg, .tool, .modal, .btn). Активную тему выбирают в Настройки → Моды → Активная тема мода.

### 2. ui — панели и кнопки в интерфейсе

Файл index.js — модуль ES. Экспорт по умолчанию получает объект alpha:

~~~js
export default function (alpha) {
  alpha.ui.registerPanel({
    id: 'clock',
    title: 'Часы',
    side: 'right',
    render(container) {
      const el = document.createElement('div')
      el.textContent = new Date().toLocaleTimeString()
      container.appendChild(el)
      const timer = setInterval(() => (el.textContent = new Date().toLocaleTimeString()), 1000)
      return () => clearInterval(timer)
    }
  })

  alpha.ui.registerStatusItem({ id: 'branch', render(el) { el.textContent = 'main' } })
  alpha.ui.registerCommand({ id: 'hello', title: 'Скажи привет', run() { alpha.ui.toast('Привет') } })
  // кнопка у поля ввода: ctx.text — черновик, ctx.replace(next) — заменить его
  alpha.ui.registerComposerAction({ id: 'prompt-improve', title: 'Улучшить промпт', async run(ctx) {
    ctx.replace(await alpha.ai.complete({ system: 'Редактор промптов.', prompt: ctx.text }))
  } })
}
~~~

Доступ: alpha.ui.registerPanel / registerStatusItem / registerSidebarItem / registerSettingsPage / registerCommand / registerComposerAction, alpha.ai.complete({system?, prompt}) — одноразовый вызов модели, alpha.settings.get(), alpha.theme.get(), alpha.log(). Доступа к fs, process и pi у ui-модов нет. Внешние библиотеки внутри index.js недоступны. registerSidebarItem рисует строку внизу левой панели проектов, registerSettingsPage — отдельную страницу в окне Настроек (оба API 1.1).

### 3. core — поведение Alpha и pi

Работает в главном процессе:

~~~js
export default function (alpha) {
  alpha.on('session:before-send', (ctx) => {
    ctx.prompt = 'Будь краток.\\n' + ctx.prompt
  })
  alpha.on('session:event', (event) => {
    if (event.type === 'tool_execution_start') alpha.ui.toast(event.toolName)
  })
  alpha.on('session:after-done', () => {})
}
~~~

Хуки: session:before-send (меняет текст сообщения), session:event (наблюдает за событиями pi), session:after-done, session:tool-call (API 1.1: получает {tool, input, cwd, chatId}, возврат {block: true, reason} отменяет вызов инструмента до гейта согласий). Также доступны alpha.settings.get(), alpha.log(), alpha.ui.toast().

## Инструменты pi, вопросы и списки задач

Ядро-мод может добавить модели собственный инструмент pi:

~~~js
export default function (alpha) {
  const { Type } = alpha.pi
  alpha.pi.registerTool({
    name: 'my_tool',
    label: 'My tool',
    description: 'Что делает инструмент, на английском.',
    promptSnippet: 'коркая строка для списка инструментов',
    promptGuidelines: ['Когда инструмент уместен'],
    parameters: Type.Object({
      query: Type.String({ description: 'Параметр' })
    }),
    async execute(toolCallId, params) {
      return { content: [{ type: 'text', text: 'готово' }], details: null }
    }
  })
}
~~~

Доступные помощники:

| API | Что делает |
|---|---|
| alpha.pi.Type | Конструктор схем TypeBox (тот же, что у pi) |
| alpha.pi.registerTool(def) | Регистрирует инструмент для модели |
| alpha.ui.ask({question, options}) | Вопрос пользователю с выбором. Возвращает Promise с ответом |
| alpha.ui.showList(id, {title, items}) | Панель списка в инспекторе. items: {text, status} со статусами todo/doing/done |
| alpha.ui.hideList(id) | Убирает панель списка |

Вопрос блокирует ход модели до ответа. Пользователь может выбрать вариант или написать свой. Список задач живёт в инспекторе и обновляется при каждом вызове. Выключение ядро-мода убирает его инструменты и списки (перезапуск для хуков).

Встроенные инструменты (не моды, отключить нельзя): ask_user (вопросы), update_task_list (список задач), web_search и web_fetch (веб-поиск и чтение страниц), project_memory (память проекта: list/add/remove фактов, хранится в ~/.alpha/memory) и subagent (независимый дочерний агент со своим контекстом, включается настройкой «Субагенты по умолчанию»). Они вшиты в Alpha и регистрируются на старте; старые моды-копии скрыты из списка.

Веб-поиск работает без API-ключей: сначала изолированный локальный SearXNG в docker (127.0.0.1:8888, Alpha запускает его сам), затем бесплатные источники — Wikipedia, Hacker News, Stack Overflow, GitHub. Если docker недоступен, работают только источники-заместители.

API версии 1.1 для ядро-модов: alpha.fs.read/write/list (запись вне корня проходит через гейт согласия), alpha.exec(command, {cwd, timeoutMs}) — shell с тем же гейтом, alpha.modSettings.get()/set(), alpha.ui.registerSettings({fields}) для своих полей в Настройки → Моды, хук session:tool-call. Для ui-модов: alpha.on('session:event'|'session:done'|'session:status', cb), registerSidebarItem, registerSettingsPage и те же registerSettings/modSettings.

## Установка

1. Ручная: скопировать папку в ~/.alpha/mods.
2. Кнопка «Установить mod» в Настройки → Моды: выбрать .zip или папку.
3. Примеры модов (noir, notes, short-prompts) ставятся при первом запуске Alpha.

## Отладка

- Ошибки загрузки видны в списке модов и в ~/.alpha/logs/alpha.log.
- Смоук-проверка без модели: npm run smoke.
- Полная справка API: MOD_API.md в корне репозитория Alpha.

## Проверки перед ответом

- Не изобретай новый API. Используй только методы из этого файла.
- Не добавляй расширения pi (extensions/, mcp.json) там, где нужен мод Alpha.
- Для новой темы меняй только токены, не дублируй весь styles.css.
`

export function installBuiltinDefaults(): void {
  const appendSystem = join(AGENT_DIR, 'APPEND_SYSTEM.md')
  const appendNeedsWrite =
    !existsSync(appendSystem) || !readFileSync(appendSystem, 'utf8').includes(APPEND_SYSTEM_MARKER)
  if (appendNeedsWrite) writeFileSync(appendSystem, APPEND_SYSTEM_MD)
  if (!existsSync(GLOBAL_AGENTS_MD) || !readFileSync(GLOBAL_AGENTS_MD, 'utf8').includes(AGENTS_MARKER)) {
    writeFileSync(GLOBAL_AGENTS_MD, AGENTS_MD)
  }

  const skillDir = join(SKILLS_DIR, 'alpha-mods')
  const skillFile = join(skillDir, 'SKILL.md')
  const needsWrite =
    !existsSync(skillFile) || !readFileSync(skillFile, 'utf8').includes(MODS_SKILL_MARKER)
  if (needsWrite) {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillFile, MODS_SKILL)
  }
}