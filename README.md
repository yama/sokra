# Sokra

**Sokra** is an AI-powered conversational interview tool that draws out honest, unfiltered feedback through natural dialogue — not forms.

Inspired by the Socratic method (*maieutics*): the truth already exists within the person. Sokra's role is simply to help bring it out.

---

## Use Cases

- Post-seminar / event feedback
- Daily standup alternative for engineers
- Project retrospectives
- 1on1 preparation
- Any situation where written forms produce hollow answers

---

## Concept

Traditional feedback forms tend to:

- Reflect the question-asker's assumptions
- Invite "correct-sounding" answers
- Bore respondents
- Favor articulate writers

Sokra instead acts as **a good listener** — reducing friction, allowing small talk, never pushing for structured answers.

> The goal is not to generate useful feedback. The goal is to collect honest words.

---

## How It Works

1. **Context setup** — The host configures seminar/event context in advance
2. **Button phase** — A few quick tap-to-answer questions to warm up and collect basic context
3. **Free conversation** — Natural dialogue, AI-driven, with hidden checkpoints
4. **Log export** — Raw conversation saved as JSON for later analysis (e.g. NotebookLM)

### Hidden Checkpoints

Sokra maintains an internal checklist of topics to cover — invisible to the respondent. Like improv comedy where performers must weave in 5 given keywords naturally, Sokra works these into conversation without ever revealing the structure.

Default checkpoints:

- Participation background
- Overall impression / temperature
- Memorable moment
- Confusion or difficulty
- Connection to real work / daily life

---

## AI Behavior Principles

**Sokra does NOT:**

- Summarize or analyze in real-time
- Push for positive framing
- Make the respondent feel interviewed
- Use phrases like "So what you're saying is..."

**Sokra DOES:**

- Use short acknowledgements ("uh-huh", "I see")
- Allow — even encourage — small talk and tangents
- Vary response length and tempo (like a human)
- Ask about *memory*, not *evaluation*
- Accept "nothing in particular" as a valid answer

---

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS (single file, no build step)
- **Backend**: Node.js (`server.js`) for API proxy + local file logging
- **AI**: Gemini API
- **Log format**: JSONL (server-side append) + JSON export (client)
- **Analysis**: Designed for NotebookLM or similar

---

## Setup

```bash
git clone https://github.com/yourname/sokra.git
cd sokra
cp .env.example .env
# .env の GEMINI_API_KEY を設定
npm start
```

Open `http://localhost:3000` in your browser. サーバーの `.env` に設定した Gemini API key が使用されます。

Session logs are saved on the server under `data/sessions/*.jsonl`.

## AI Commit Workflow (Copilot / Claude / Codex)

このリポジトリでは、コミットメッセージ生成ルールを共通化しています。

- 規約本体: `docs/commit-convention.md`
- AI入力テンプレート: `docs/commit-prompt.md`
- クライアント向け設定:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `.github/copilot-instructions.md`

任意で、gitのコミットテンプレートを有効化できます。

```bash
git config commit.template .gitmessage.txt
```

---

## Roadmap

- [ ] Host configuration UI (seminar context, custom checkpoints)
- [ ] Pre-interview flow for hosts
- [ ] Multi-session log aggregation
- [ ] Timing controls (send link after event, not immediately)
- [ ] Generalize beyond seminars

---

## License

MIT
