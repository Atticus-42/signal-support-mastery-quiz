# Signal Support Mastery Quiz

A free, browser-based practice aid for the *Signal Support in Combined Arms Operations* lesson (Module 3). Students enter a name, confirm the study warning, and take a 25-question Easy, Medium, or Hard examination at https://atticus-42.github.io/signal-support-mastery-quiz/. Questions are reshuffled on every attempt. The header links back to all quizzes at https://atticus-42.github.io/quiz-hub/#module-3.

Questions use only the substantive content of the 19-page student handout: the definitions of Signal Operations, Signal Support Operations, Combined Arms Operations and Signal Support to Combined Arms Operations; the operational environment (seven characteristics, PMESII-PT, METT-TC and the physical, cyberspace and electromagnetic spectrum environments); roles; systems and technologies; principles; tactical considerations; planning and coordination; and security measures and protocols. The learning-objective list is excluded. Scenarios are fictional Philippine Army situations grounded in those pages, and each explanation cites the handout page.

No login, payment, analytics, cookies, advertising, external fonts, images, scripts or runtime libraries. Answers stay in browser memory. Only the name, difficulty, score and finish time are sent to the class history Google Sheet (tab "Signal Support History") through `HISTORY_ENDPOINT` in `src/template.html`.

`src/questions/` holds the three banks, `src/template.html` is the page source, and `scripts/build.mjs` produces the self-contained `index.html`. `apps-script/Code.gs` is the shared history web app (one spreadsheet, one tab per lesson). Test gate:

```sh
node scripts/build.mjs && node scripts/verify.mjs
```
