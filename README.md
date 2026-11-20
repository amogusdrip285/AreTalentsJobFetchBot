# AreTalents Job Fetch Bot

Copies job descriptions from your [AniDay](https://app.aniday.com) headhunter account into your [AreTalents](https://www.aretalents.com) workspace.

```text
AniDay  --npm start-->  data/jobs.json  --npm run push-->  AreTalents drafts
                                         --node src/pushCli.js --publish-->  public job board
```

> **Jobs arrive as drafts unless you add `--publish`.** Drafts appear only in your workspace at <https://www.aretalents.com/web/jobs>. Published jobs appear on the public job board at <https://www.aretalents.com/viec-lam> and accept applications.

> **Pushed jobs can't be deleted.** AreTalents has no delete for jobs, so always preview with `--dry-run` first. A published job can be closed, but the bot can't do this yet: see [Taking a job down](#taking-a-job-down).

## What you need

- [Node.js](https://nodejs.org) 22 or newer. Check with `node --version`. Then run `npm install` once.
- An AniDay headhunter account.
- An AreTalents account, or the bot can create one for you in step 2.

> **Options go through `node`, not `npm`.** Commands with options are written as `node src/pushCli.js --publish`. The `node src/pushCli.js --publish` form doesn't work in Windows PowerShell, which removes the `--`. If that happens, the bot stops without doing anything and tells you the command to use.

## Quick start

### 1. Add your accounts

Copy the example settings file:

```bash
# macOS / Linux / Git Bash
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Open `.env` and fill in `ANIDAY_EMAIL`, `ANIDAY_PASSWORD`, `ARETALENTS_EMAIL` and `ARETALENTS_PASSWORD`.

`.env` holds your passwords. Don't commit or share it.

### 2. Create your AreTalents API key

Already have an AreTalents account:

```bash
npm run setup
```

Need a new one (it's created as a `HEADHUNTER` account):

```bash
node src/setupCli.js --register
```

This saves a key to `.env`. It can only read and write jobs, and it lasts 90 days. To replace an expired key, clear `ARETALENTS_API_KEY` in `.env` and run `npm run setup` again.

### 3. Fetch the jobs from AniDay

```bash
npm start
```

This reads every IT job and saves it to `data/jobs.json`. It waits a second between requests, so about 100 jobs takes a couple of minutes.

To read a few jobs in the terminal as well:

```bash
node src/cli.js --limit 5 --show 2
```

### 4. Preview the push

```bash
node src/pushCli.js --dry-run
```

This sends nothing. It prints one line per job showing what would happen:

```text
would-push        16367  IT_MIDDLE_MANAGER -      Project Manager
unclassified      16465  -                 -      RF Engineer
restricted        16120  -                 -      Solutions Architect
```

Check the role families here, because this is the last chance to catch a wrong one cheaply.

### 5. Push to AreTalents

```bash
npm run push
```

You can run this as often as you like. Jobs that are already on AreTalents are skipped, so it's safe to run again after a failure or after fetching new jobs.

### 6. Publish to the public job board

Try one job first:

```bash
node src/pushCli.js --publish --id 16470 --dry-run
node src/pushCli.js --publish --id 16470
```

Open the link it prints and check the page. Then preview everything before publishing it:

```bash
node src/pushCli.js --publish --dry-run
node src/pushCli.js --publish
```

`--publish` handles drafts you've already pushed as well as new jobs. See [What gets published](#what-gets-published) for how each job is set up.

## Reading the results

| Result | Meaning | What to do |
|---|---|---|
| `pushed` | Created on AreTalents as a draft | Nothing |
| `published` | Live on the public job board | Nothing |
| `would-push` | Dry run only: would be created | Run without `--dry-run` |
| `would-publish` | Dry run only: would be published | Check the work mode, then run without `--dry-run` |
| `already-pushed` | Listed in `data/pushed.json`, so nothing was sent | Nothing |
| `already-published` | Listed in `data/published.json`, so nothing was sent | Nothing |
| `exists` | AreTalents already has this job, but it isn't in `data/pushed.json` | To publish it, add it to that file ([how](#keep-the-data-files)) |
| `unclassified` | No role family fits the title | Add it with `--assign` if it belongs on AreTalents |
| `restricted` | AniDay doesn't let this account read the description | Nothing the bot can do: ask AniDay for access |
| `failed` | AreTalents refused the job or had an error | Read the error, then run the push again |
| `not-attempted` | The batch stopped early | Fix the error above it, then run the push again |

The batch stops at the first login, permission or rate-limit error (HTTP 401, 403 or 429), because every remaining job would fail the same way. The exception is a 403 when publishing, which means an AreTalents admin revoked that job. Only that job fails, and the bot can't publish it again.

## Role families

AreTalents requires every job to be one of three role families. The bot picks one from the job title:

| Role family | Examples |
|---|---|
| `DEVELOPER` | Engineers, developers, architects, data, DevOps, SAP consultants |
| `TESTER` | QA, QC, testers |
| `IT_MIDDLE_MANAGER` | Project and product managers, product owners, business analysts, IT managers |

Titles that fit none of these, such as marine, electrical, telecoms and sales roles, are left as `unclassified` and aren't sent. To choose a role family yourself:

```bash
node src/pushCli.js --id 16229 --assign 16229=DEVELOPER
```

To change the title rules, edit `src/roleFamily.js`.

## What gets published

The public page shows the title, company, location, work mode, skills as tags, requirements, nice-to-haves and benefits. Its description holds the level, the job description and the interview process.

Before a job goes live, the bot replaces its JD on AreTalents with this shorter text, because the page shows the other details itself. The full version stays in the job's history.

The page also needs a few things AniDay doesn't provide:

| Field | How it's set |
|---|---|
| Work mode | `Remote` if AniDay's location is Remote, `Hybrid` if the JD mentions hybrid work, otherwise `Onsite` |
| Category | `mobile`, `devops`, `data` or `frontend` from a developer's job title, otherwise chosen by AreTalents from the role family |
| Salary | A monthly salary equal to the job's referral bonus, rounded to the nearest million VND (a 30,000,000 VND bonus shows as 30 triệu). Left out, so the page shows it as negotiable, if the job has no bonus |
| Deadline | 30 days after publishing, set by AreTalents |

The work mode is a best guess, so check it in the dry run. To set it yourself:

```bash
node src/pushCli.js --publish --id 16229 --work-mode 16229=Hybrid
```

### Taking a job down

The bot can't close a published job yet. Call the AreTalents API directly, with your job's ID from `data/pushed.json`:

```bash
curl -X POST "$ARETALENTS_BASE_URL/api/v1/jobs/<job id>/unpublish" \
  -H "Authorization: Bearer $ARETALENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"CLOSE"}'
```

The job stops taking applications immediately. Applications go to the AreTalents account that owns the job.

## Post the jobs to Threads

`node src/threadsCli.js` posts every job that's live on the public job board to Threads, one post per job. Each post has a short Vietnamese write-up (the role, location, level, top skills, best perks and the job link) and an image card.

It runs entirely on its own: it logs in to threads.com in Chrome, fills in each post, attaches the card and clicks Post. There's no phone, Threads API key or AI involved. You need:

- Google Chrome, or Microsoft Edge with `--browser msedge`.
- Windows, because the image cards are drawn with Windows PowerShell. Elsewhere, add `--no-image`.
- In `.env`: `THREADS_USERNAME` and `THREADS_PASSWORD` for any Threads account. To post from another account, change them.

After the first login the session is saved to `data/threads/session-<username>.json`, so later runs don't log in again. If Threads asks for a login code or a security check, the bot stops. Run it once with `--headed` to see the browser window, finish the check there, and the bot carries on.

Preview first. This writes every post and its card to `data/threads/posts.md` and `data/threads/cards/`, and doesn't open Threads:

```bash
node src/threadsCli.js --dry-run
```

Then try one job without posting it. The bot logs in, fills in the post, checks the text and the card, and saves a screenshot to `data/threads/compose/`:

```bash
node src/threadsCli.js --compose-only --id 16466
```

Then post:

```bash
node src/threadsCli.js
```

The bot waits 4 to 9 minutes between posts so the account doesn't look like a spam bot, so 50 jobs take about 6 hours. Leave the computer on.

Each account has its own record of posted jobs in `data/threads/posted-<username>.json`, and jobs in it are skipped, so you can stop with Ctrl+C and run again to carry on. A new account posts every job. If something goes wrong after the bot clicked Post, it stops instead of trying again, because the post may already be live. Check the profile, add the job to that file if it went out, and run again.

| Option | Meaning | Default |
|---|---|---|
| `--dry-run` | Write the posts and cards to `data/threads/` only | off |
| `--compose-only` | Fill in and check each post, screenshot it, but don't post | off |
| `--id <id>` | Only this job. Repeat for more | all published jobs |
| `--limit <n>` | Post at most n jobs this run | all |
| `--headed` | Show the browser window, such as to finish a login check | off |
| `--browser <name>` | `chrome` or `msedge` | `chrome` |
| `--min-gap <min>` / `--max-gap <min>` | Pause between posts, in minutes | `4` / `9` |
| `--no-image` | Post text only | off |

How it drives Threads: it opens Threads' own share link (`threads.com/intent/post?text=...`), which fills in the composer with the line breaks intact. It checks the text matches, attaches the card, removes any link preview, checks the card is the only attachment, and clicks Post. If Threads changes its website, the selectors in `src/threadsWeb.js` may need updating.

## Post the jobs to Facebook

`node src/facebookCli.js` posts the same jobs, with the same text and card, to Facebook as public posts. It works like the Threads bot, but drives the Facebook app on an Android phone over ADB. You need:

- An Android phone on the same Wi-Fi with **ADB over Wi-Fi** on (`adb tcpip 5555` once over USB), the Facebook and Chrome apps installed, and no PIN or pattern lock (or its screen kept on).
- `adb` on this computer's PATH. It comes with [scrcpy](https://github.com/Genymobile/scrcpy) or Android's platform tools.
- In `.env`: `FACEBOOK_EMAIL` and `FACEBOOK_PASSWORD`. If Facebook is signed out on the phone, the bot logs in with them. If Facebook asks for a code or security check, finish it on the phone and run again.
- Optionally `FACEBOOK_ADB_DEVICE=192.168.1.251:5555`. Without it the bot scans the local network for the phone.

```bash
node src/facebookCli.js --dry-run
node src/facebookCli.js --compose-only --id 16466
node src/facebookCli.js
```

`--compose-only` fills in the post up to the Post button, saves a screenshot to `data/facebook/compose/`, and discards the draft. The options are the Threads ones, with `--device <ip:port>` instead of `--headed` and `--browser`. Posted jobs are recorded per account in `data/facebook/posted-<email>.json`.

How it drives Facebook: Facebook ignores text shared to it, and ADB can't type Vietnamese or emoji, so the bot opens a small page in Chrome on the phone and taps it to copy the post to the clipboard. It then shares the card to Facebook, pastes the text in, checks the text matches and the card is the only attachment, sets the audience to Public and taps Post. If Facebook changes its app, the labels in `src/facebookBot.js` may need updating.

## Options

`node src/cli.js [options]`

| Option | Meaning | Default |
|---|---|---|
| `--pages <n>` | Only read the first n list pages | all |
| `--limit <n>` | Only process the first n jobs | all |
| `--job-type <id>` | AniDay `jobTypeId` | `1` (IT) |
| `--delay <ms>` | Pause between requests, minimum 200 | `1000` |
| `--out <path>` | Output file | `data/jobs.json` |
| `--show <n>` | Print n job descriptions | `0` |

`node src/pushCli.js [options]`

| Option | Meaning | Default |
|---|---|---|
| `--dry-run` | Preview only, send nothing | off |
| `--publish` | Also publish to the public job board | off |
| `--republish` | Publish jobs in `data/published.json` again to update their public page. Implies `--publish` | off |
| `--id <id>` | Only this job. Repeat for more | all jobs |
| `--assign <id=ROLE>` | Set a job's role family. Repeat for more | title rules |
| `--work-mode <id=MODE>` | Set a job's work mode: `Remote`, `Hybrid` or `Onsite`. Repeat for more | worked out from the job |
| `--delay <ms>` | Pause between requests, minimum 200. Publishing takes 3 or 4 requests per job | `1000` |
| `--in <path>` | Input file | `data/jobs.json` |

## What gets sent

The bot sends the job title, company name, location, level, skills, description, requirements, nice-to-haves, benefits and interview process, plus the AniDay job ID and your numeric AniDay account ID so that AreTalents can detect duplicates.

It never sends AniDay contact details, private notes or your passwords. The referral bonus isn't sent as such, but with `--publish` the public salary is set to it, so the bonus amount can be read from the job page.

Jobs that AniDay marks as private are skipped, not worked around.

Each job's client name and JD text belong to AniDay and its clients. Check AniDay's terms before using `--publish`, because it shows them on a public website.

## Keep the data files

`data/published.json` records which jobs are public, and the push skips them. To update jobs that are already public, such as after changing how the salary is worked out, add `--republish` (it implies `--publish`):

```bash
node src/pushCli.js --republish --dry-run
node src/pushCli.js --republish
```

Add `--id` to update only some jobs. Without it, any job that's ready but not yet public is published too, so check the dry run. Public links stay the same, and each deadline moves to 30 days from then.

`data/pushed.json` records which AniDay job became which AreTalents job. If you lose it, the bot still avoids duplicates for jobs it pushed, because AreTalents rejects them and reports `exists`. The exception is a job you added some other way, such as by hand, which AreTalents can't match to AniDay. To skip one of those, add it to the file yourself:

```json
{ "16466": "the-aretalents-job-id" }
```

The `data/` folder isn't committed to git, so back it up if you move to another computer.

## Troubleshooting

| Message | Fix |
|---|---|
| `ANIDAY_EMAIL and ANIDAY_PASSWORD must be set in .env` | Do step 1 |
| `AniDay login failed` | Check the AniDay email and password in `.env`, and that you can sign in on the website |
| `ARETALENTS_BASE_URL and ARETALENTS_API_KEY must be set in .env` | Do step 2 |
| `Stopped: npm kept ...` | Run the `node` command shown in the message |
| `AreTalents HTTP 401` | The key has expired or is wrong: create a new one as in step 2 |
| `Expected something like ...` | An `--assign` or `--work-mode` value is mistyped. Values are case-sensitive |
| `Not in the input file: ...` | An `--id` or `--assign` value is mistyped, or the job needs fetching: do step 3 again |
| `... has no accountRef; run npm start again` | The job file came from an older version: do step 3 again |
| `Unsupported engine` or a Node.js syntax error | Install Node.js 22 or newer |

## For developers

```bash
npm test
```

Tests use fake network responses, so they need no accounts. The Threads browser tests run Chrome against a stand-in page on localhost, and are skipped where Chrome isn't installed.

| File | Purpose |
|---|---|
| `src/cli.js` | `npm start` |
| `src/anidayClient.js` | AniDay API: login, retries and throttling |
| `src/fetchJobs.js` | Walks the job list and fetches each job's details |
| `src/jobMapper.js` | Turns AniDay data into clean records |
| `src/pushCli.js` | `npm run push` |
| `src/facebookCli.js` | Posts published jobs to Facebook |
| `src/facebookBot.js` | Drives the Facebook app over ADB: login, compose, Post |
| `src/adbDevice.js` | ADB helpers: find and connect the phone, read and tap its screen |
| `src/threadsCli.js` | Posts published jobs to Threads |
| `src/threadsPost.js` | The Threads post text and image card contents |
| `src/jobCard.js`, `src/render/jobCard.ps1` | Draws the image cards |
| `src/threadsWeb.js` | Drives threads.com in Chrome: login, session, compose, Post |
| `src/pushJobs.js` | Batch rules: skip, send, stop |
| `src/roleFamily.js` | Title rules for role families |
| `src/areTalentsClient.js` | AreTalents API and job formatting |
| `src/publication.js` | Public page content, work mode and category rules |
| `src/setupCli.js`, `src/areTalentsSetup.js` | `npm run setup` |

The AreTalents API is documented at <https://www.aretalents.com/openapi.yaml>. AniDay has no public API docs, so a change on their side may break fetching.
