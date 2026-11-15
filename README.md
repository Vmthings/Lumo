# Lumo

Lumo is a lesson creator for teachers. Build a lesson with slides and quiz questions (by hand or with AI), host it live, and let students join with a code. No student accounts are needed.

## Set up on GitHub Pages

1. Create a GitHub repository and upload `index.html`, `SKILL.md` and this `README.md` to the main folder.
2. Open **Settings → Pages**, choose your main branch and the root folder, then save.
3. Open the address GitHub shows you. That is your Lumo site. Share the same address with students.

Keep `index.html` and `SKILL.md` in the same folder. The AI reads `SKILL.md` for its instructions.

To use your own proxy or a different built-in model, change `PROXY` and `MODEL` near the top of the script in `index.html`.

## For teachers

### Create an account
On the home page, enter a username and a password of at least 6 characters under **Teachers**, then press **Create account**. Next time, press **Log in**.

Accounts and lessons are stored in your browser on that device. They don't sync between devices, and clearing your browser data deletes them.

### Build a lesson
Press **+ New lesson**, then add content in either way, or mix both.

- **By hand:** Press **+ Slide** or **+ Quiz question**. Questions have four options. Pick the correct one with the radio button. Use ↑ and ↓ to reorder and ✕ to delete.
- **With AI:** Enter a topic, an audience (for example, Year 8) and a slide count, then press **Generate with AI**. This replaces the lesson's current content.
- **Suggest edits:** Press **✨ Suggest edits** and the AI proposes improvements for individual items. Accept or dismiss each one.

### Lesson options
- **Leaderboard mode:** Shows the top 5 students on their screens. You can also switch it on or off during a live lesson.
- **Lesson first, then quiz:** On by default. Students see all the slides first, then a "Quiz time" screen, then all the questions. Turn it off to run items in the order you built them.
- **Let AI write quiz questions:** When off, the AI only writes slides.
- **AI web search:** Lets the AI look things up. It works with some providers only (see Advanced settings).

### Chat with the AI assistant
The assistant chat in the editor answers questions and can change your lesson. Each lesson keeps its own chat history.

- **Plan mode (default):** The AI replies and lists the steps it would take. Nothing changes until you press **Apply plan**.
- **Agent mode:** The AI makes its changes straight away and lists what it did. Press **Undo last AI change** to restore the lesson.
- **Clear history** deletes the lesson's chat.

### Host a lesson
1. Press **Host** on the dashboard or in the editor.
2. Give students the 5-letter code on screen.
3. Use **Previous** and **Next** to move through the lesson.
4. On a question, wait for answers, then press **Reveal answer**. Each correct answer scores 100 points.
5. Press **End lesson** when you finish.

Keep the hosting tab open for the whole lesson. Students can also send you suggestions, which appear on your screen.

### Settings
Open **Settings** in the header.

- **Enable AI features:** Turn this off to hide all AI tools. You can still build slides and quizzes by hand.
- **AI files:** The AI's virtual files. `SKILL.md` holds its instructions and `memory.md` holds what it has remembered. You can edit them, add files, or press **Reset SKILL.md** to restore the default.
- **Advanced:** Pick a provider and model.
  - **Built-in (limited):** Uses the shared proxy with a fixed model, capped at 40 requests a day per browser.
  - **Claude, Gemini, ChatGPT, Groq, DeepSeek:** Paste your own API key, then type a model ID or press **Load models**. **Test connection** checks the setup. Web search works with Claude, Gemini and Groq (gpt-oss models).

## For students

1. Open the Lumo address your teacher gave you.
2. Enter the lesson code and your name, then press **Join lesson**.
3. Follow along. On a question, tap an answer. It locks in when you tap it.
4. When the teacher reveals the answer, you will see whether you were right.

You can type a suggestion to your teacher at the bottom of your screen at any time.

## Good to know

- **Keys are not secret on a shared computer.** API keys are stored in plain text in the browser and sent directly to the provider. Don't use your own key on a shared device.
- **Live lessons use a free peer-to-peer service (PeerJS).** Some school networks block it. If students can't connect, try another network.
- **The built-in daily limit is enforced in the browser only.** It can be reset by clearing site data. Enforce limits in your proxy if that matters.
- **AI makes mistakes.** Read what it writes before you teach it.
- **Some providers block requests from web pages.** If **Test connection** says "Failed to fetch", check the key first, then try another provider.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app |
| `SKILL.md` | Instructions the AI follows |
| `README.md` | This guide |
