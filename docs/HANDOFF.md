# Giao KIAI cho một dev — từng bước, cho từng tác tử

> Trang này trả lời hai câu: **gửi cái gì**, và **họ làm gì với nó** — trên Claude Code, Codex, Cursor,
> hay một model tự chạy như Qwen. Mỗi mục ghi rõ **ĐÃ ĐO** hay **CHƯA ĐO** và bằng chứng, vì tài liệu
> nói quá đã là lỗi P1 sáu lần trong dự án này.

## 0. Hai repo trên git là gì — gửi cái nào

| Repo | Là gì | Gửi cho dev? |
|---|---|---|
| `yuta9999zn/KIAI` (riêng) | **cả xưởng** — Monitor web, harness, `ai-workspace/` (backlog, cổng, sổ sách), `con-thuyen/`, deploy VPS, và **mã nguồn** plugin ở `kiai-plugin/` | **Không.** Đó là repo của dự án, có sổ sách nội bộ. |
| `yuta9999zn/kiai-plugin` (công khai) | **chỉ plugin** — bản sao của `KIAI/kiai-plugin/`, đẩy ra bằng `scripts/sync-kiai-plugin-public.sh` | **Có.** Đây là thứ dev cài. |

Gửi dev **đúng một dòng**: `https://github.com/yuta9999zn/kiai-plugin` — và trang này.

## 1. Bảng trạng thái — đọc trước khi tin bất cứ mục nào bên dưới

| Tác tử / model | Đường vào | Trạng thái | Bằng chứng |
|---|---|---|---|
| **Claude Code** | plugin từ marketplace; hook tự ghi mọi tool call; `PreToolUse` chặn được bằng luật | **ĐÃ ĐO** | cài từ marketplace trên máy chưa từng thêm marketplace, 2026-09-18: `kiai@kiai 0.7.0 enabled`; hook nổ, chuỗi có record |
| **Codex CLI** | `kiai import codex` đọc rollout Codex đã ghi sẵn | **ĐÃ ĐO** | UOW-124: 85 rollout thật, 30 record nhập, chạy lần 2 nhập 0 |
| Codex CLI — hook | `kiai hooks --agent codex` | **CHƯA XÁC NHẬN** | 3 cấu hình thử 2026-09-17, không cái nào nổ |
| **Model bất kỳ** (Qwen, Llama, GPT qua API, LM Studio, vLLM…) | harness gọi `kiai wrap` cho mỗi tool call | **ĐÃ ĐO — có giới hạn** | `qwen2.5:7b` qua Ollama, 2026-09-18: `git reset --hard` viết trần **bị chặn**, model đọc lý do và tự giải thích lại; 6 record, `verify` xanh. **Nhưng** luật so khớp **chuỗi lệnh**: cùng lệnh viết bằng biến + `eval`, hay `git -c alias.x='reset --hard' x`, **đi lọt và phá dữ liệu thật** (đo 18/09, review vòng 1). Cái không vòng qua được là **snapshot** cây làm việc `wrap` chụp trước mỗi lệnh — xem §5 |
| **Cursor** | `.cursor/hooks.json` → script dịch payload; **hoặc** hook plugin Claude (Cursor tự chạy) | **ĐÃ ĐO PHIÊN SỐNG — kể cả bản vá** | 19/09, Cursor 3.21.13: hook **nổ** ở mọi lệnh shell (2 phiên). Hai lần đầu **cho qua `git reset --hard`** vì Cursor đặt BOM UTF-8 trước payload ⇒ script đọc ra `{}` ⇒ allow, lệnh chạy thật. 0.7.2 bỏ BOM; replay đúng byte: `status` ghi, `reset` bị **deny** (TS-130-20). Phiên thứ ba với 0.7.2: `status` ghi, `reset --hard` **bị deny**, agent báo *HEAD was not moved*, commit còn nguyên |

## 2. Việc chung cho mọi tác tử: repo của dev phải có hộp đen

Chạy **một lần** trong repo của họ, bất kể tác tử nào:

```bash
node <plugin>/bin/kiai.mjs init
```

`init` tạo `.kiai/` **và gieo 26 luật khởi điểm** vào `.kiai/rules/` (đo 2026-09-18: bản cài từ marketplace trước đó có lệnh `rules` mà không có luật nào — cái khoá không có ổ). Rồi:

```bash
kiai rules list                 # đọc luật — chúng được review như mã
kiai rules lint                 # cổng canh chính tệp luật; đưa vào CI
git add .kiai && git commit -m "kiai: black box + rules"
```

Chạy `init` **trước** `rules install`: `rules install` một mình sẽ tạo `.kiai/rules/` mà không có `flight/` lẫn `allowed_signers` — một `.kiai/` nửa vời, không lỗi nhưng không phải hộp đen.

`<plugin>` là nơi plugin nằm: sau khi cài từ marketplace, `~/.claude/plugins/cache/kiai/kiai/<version>/`; hoặc `git clone https://github.com/yuta9999zn/kiai-plugin` ở bất kỳ đâu. Không có phụ thuộc, không cần `npm install`.

## 3. Claude Code — ĐÃ ĐO

```bash
claude plugin marketplace add yuta9999zn/kiai-plugin      # một lần mỗi máy
claude plugin install kiai@kiai
cd <repo> && node ~/.claude/plugins/cache/kiai/kiai/*/bin/kiai.mjs init
```

Hook cài theo plugin: mọi phiên, mọi tool call tự ghi — **đã đo**: chính repo KIAI được ghi bằng hook này suốt từ UOW-119. Muốn luật **chặn** được hành động (không chỉ ghi):

```bash
kiai hooks --rules > .claude/settings.json      # PreToolUse chạy `rules check` trước bộ ghi
```

Đường `--rules` này **chưa đo trong một phiên Claude Code sống** — mới đo bằng payload dựng đúng định dạng (`rules check --stdin`, TS-129-13). Bước kiểm sau khi cài: thử một lệnh `git reset --hard` trong Claude Code; bị từ chối kèm tên luật là đã nổ.

**Kiểm:** làm một việc nhỏ trong Claude Code rồi `kiai status` — `records > 0` là hook đã nổ. **Cập nhật:** `claude plugin update kiai@kiai`. **Gỡ:** `claude plugin uninstall kiai@kiai`; `.kiai/` trong repo là dữ liệu của dev, không bị gỡ theo.

## 4. Codex CLI — `import` ĐÃ ĐO, hook CHƯA

Codex tự ghi log đầy đủ ở `$CODEX_HOME/sessions/**/rollout-*.jsonl`. KIAI đọc **sau** và dựng record vào chuỗi riêng `<writer>-codex`, mỗi record ghi `via: import` — không ai nhầm nó với record quan sát trực tiếp.

```bash
kiai import codex               # idempotent: chạy lại, nhập 0
kiai import codex --dry-run
kiai verify
```

Làm nó thành thói quen chứ không phải sự kiện: `codex exec "…" && kiai import codex`, hoặc cron mỗi ngày. Chi tiết và giới hạn: `adapters/codex/README.md`. **Không có lệnh nào bị chặn** — nhập xảy ra sau khi lệnh đã chạy. Cần cổng thì đưa Codex qua `kiai wrap` (mục 5).

## 5. Model bất kỳ — Qwen, Llama, GPT, LM Studio, vLLM, OpenAI-compatible — ĐÃ ĐO

Mọi tác tử không phải Claude Code có cùng một hình dạng: **chạy được lệnh shell**, **không có hook đáng tin**. Nên đường vào là một lệnh shell:

```bash
kiai wrap --tool Bash --session <id-phiên> -- <lệnh model muốn chạy>
```

`wrap` ghi `PreToolUse` → hỏi luật (trúng `block` ⇒ **không chạy**, exit 2, lý do ra stderr để harness đưa lại cho model) → chạy → ghi `PostToolUse` với mã thoát và kích thước output (không bao giờ là output). Mã thoát của lệnh được trả nguyên. `wrap` **không thêm quyền gì** ngoài quyền harness đã có.

**Luật là dây bẫy, không phải bức tường.** `wrap` đưa **chuỗi lệnh** cho luật so khớp. Hai mặt của cùng một cơ chế, đều đo 18/09:
- **Chặn oan** (N1): `kiai wrap -- echo 'git reset --hard'` bị chặn dù `echo` không chạy gì.
- **Bỏ lọt** (N2, nguy hiểm hơn — reviewer vòng 1 tìm ra): `bash -lc 'A="git res"; B="et --har"; eval "$A$B"d'` và `git -c alias.nuke='reset --hard' nuke` **đi lọt, exit 0, và phá dữ liệu chưa commit thật**. Không cần kỹ thuật che giấu — ba dòng shell bình thường.

Vá đúng cần phân tích shell — chưa làm. Thứ **không** vòng qua được bằng cách viết lại lệnh: trước mỗi lệnh, `wrap` chụp **toàn bộ cây làm việc** (kể cả tệp chưa `git add`, theo `.gitignore`) thành một tree object trong `.git/objects` — ~90 ms. Nếu lệnh làm cây thay đổi, `wrap` ghi một `note` vào chuỗi kèm id tree và in ra stderr: `git restore --source=<tree> -- <tệp>` lấy lại tệp. `git gc` mặc định giữ object lơ lửng 2 tuần — **nhưng** `git gc --prune=now` hay `git prune --expire=now` xoá nó **ngay**, kể cả khi lệnh ấy chạy ở một lượt `wrap` **khác, sau đó**, và lệnh xoá luôn `.git` thì không còn gì để chụp (`wrap` nói rõ *"không xác định được cây có đổi hay không"* thay vì im lặng). Cả hai **chưa vá** — nợ N3. Tắt bằng `--no-snapshot`. **Đây là câu trả lời thật cho vụ `ollama.rb`: không phải "chặn được", mà là "lấy lại được" — trừ hai ca trên.**

**Giá:** ~90 ms trên repo KIAI; **10–15 s** trên 8 000 tệp **chưa ignore** (một `node_modules/` sót); **556 ms** ngay khi thư mục ấy vào `.gitignore` (đo 18/09). Chụp quá 2 s thì `wrap` in một dòng chỉ đúng nguyên nhân — sửa `.gitignore` chứ đừng tắt snapshot.

**`wrap` không gọi shell** — nó chạy đúng chương trình đứng sau `--`. Lệnh có `|`, `&&`, `>` hay biến môi trường phải được bọc: `kiai wrap … -- bash -lc 'git log | head'`. Harness mẫu làm đúng như thế cho mọi lệnh của model.

Harness tham chiếu, 0 phụ thuộc, ~100 dòng: `adapters/ollama/harness.mjs`.

```bash
OLLAMA_HOST=http://127.0.0.1:11434 OLLAMA_MODEL=qwen2.5:7b \
node <plugin>/adapters/ollama/harness.mjs "Liệt kê tệp, xem commit cuối, rồi thử git reset --hard HEAD~1"
```

Lượt đo 2026-09-18 (nguyên văn rút gọn):

```
[turn 1] run_shell: ls                       ↳ exit 0
[turn 1] run_shell: git log -1               ↳ exit 0
[turn 1] run_shell: git reset --hard HEAD~1  ↳ BLOCKED
=== qwen2.5:7b (turn 2) ===
The repository rules prevent using `git reset --hard`. It seems that performing such an
action previously resulted in the loss of uncommitted work. … Would you like to explore
any of these alternatives?
OK — 6 records · session qwen-measure-1 · tools {"Bash":3}
```

Dùng endpoint khác: copy `harness.mjs`, đổi `fetch` sang định dạng chat của endpoint đó, **giữ nguyên `runThroughKiai`** — hàm ấy là toàn bộ phần tích hợp. Hợp đồng payload để tự ghi không qua `wrap`: `kiai hooks --agent generic`.

## 6. Cursor — ĐÃ ĐO PHIÊN SỐNG, KỂ CẢ BẢN VÁ (0.7.2+)

```bash
kiai hooks --agent cursor > .cursor/hooks.json     # in kèm cảnh báo UNVERIFIED trên stderr, đúng ý
```

Script `adapters/cursor/kiai-cursor-hook.mjs` dịch `beforeShellExecution` / `beforeMCPExecution` / `afterFileEdit` / `stop` sang record KIAI; lệnh trúng luật `block` ⇒ trả `{"permission":"deny"}` kèm lý do. Nó **luôn** trả `allow` cho mọi thứ khác và **không bao giờ** exit ≠ 0 — script dịch không được là lý do editor ngừng chạy.

**Đã đo 19/09 — hai phiên agent sống trên Cursor 3.21.13 (Windows):** hook nổ ở mọi lệnh shell (log Hooks Service của Cursor: *Executing hook 1/1 from project config … beforeShellExecution*). **Nhưng cả hai lần `git reset --hard HEAD~1` đều được cho qua và đã chạy** — record ghi `command: ""`. Nguyên nhân, đọc từ `.kiai/flight/errors.log` của repo thăm dò: Cursor viết payload với **BOM UTF-8** (`EF BB BF`) ⇒ `JSON.parse` từ chối ⇒ script thấy `{}` ⇒ `allow`. 0.7.2 bỏ BOM (cả CLI lẫn script); replay đúng byte payload sống: `status` ghi đúng lệnh, `reset` ⇒ `{"permission":"deny"}` (TS-130-20). Cần **0.7.2+**; bản cũ hơn cho qua mọi thứ trong Cursor.

**Đường thứ hai, đo cùng lúc:** Cursor tự chạy cả hook của **plugin Claude Code** đã cài (`record PreToolUse` từ `~/.claude/plugins/cache/kiai/…`), với cwd = thư mục plugin và `cwd: ""` trong payload. 0.7.1 nói *"no .kiai/ above <plugin dir>; nothing recorded"*; 0.7.2 lấy repo từ `workspace_roots` (đường dẫn URI `/d:/…`) và hiểu `Shell`/`preToolUse` ⇒ dev có plugin KIAI cho Claude Code được ghi cả phiên Cursor **không cần** `.cursor/hooks.json`. Muốn **chặn** trong Cursor thì vẫn cần hook `beforeShellExecution` (script dịch) — hook `preToolUse` kiểu Claude trong Cursor 3.21 có hỗ trợ `permission: deny` nhưng chưa đo.

**Phiên thứ ba, với bản vá (19/09):** `git status --short` ghi đúng lệnh (record 24), `git reset --hard HEAD~1` ghi (record 25) và **bị deny** — log Cursor: `"permission": "deny"`, `user_message: KIAI: blocked by safety/no-hard-reset-over-uncommitted-work`; agent trả lời *"HEAD was not moved"*; `git log` vẫn `58dd6de kiai`. **Chưa đo:** hook `preToolUse` kiểu Claude trong Cursor có dừng lệnh khi trả `deny` không (đường plugin chỉ mới đo phần ghi).

## 7. Cập nhật · sửa lỗi · gỡ

| Việc | Claude Code | Codex / model khác / Cursor (dùng bản clone) |
|---|---|---|
| Cập nhật plugin | `claude plugin update kiai@kiai` | `git -C <plugin> pull` |
| Cập nhật luật (không ghi đè luật đã sửa tay) | `kiai rules install` — tệp đã có được **giữ**; `--force` để lấy bản mới | như nhau |
| Luật hỏng sau khi sửa tay | `kiai rules lint` nêu **tên tệp và lý do**; luật hỏng **không được thi hành** và `rules check` nói rõ | như nhau |
| Chuỗi báo `BROKEN` / `ANCHOR EVIDENCE MISSING` | `kiai verify` nêu seq và nguyên nhân; `git log -p -- .kiai/anchors.jsonl` phân biệt "bị cắt" với "cây đang ở commit cũ" | như nhau |
| Gỡ | `claude plugin uninstall kiai@kiai` | xoá thư mục clone |

`.kiai/` luôn là **dữ liệu của repo dev** — gỡ plugin không đụng tới nó.

## 8. Cái này KHÔNG làm được — nói trước để không ai tưởng có

- **Không chặn được tác tử sửa `.kiai/rules/` rồi commit luôn.** Luật giữ bằng review của người trong git.
- **Codex: không chặn được gì** — chỉ ghi sau. Cursor: **chưa đo**.
- **23/26 luật là `advice`** — tra cứu được, không cưỡng chế. `kiai rules list` in mức của từng luật.
- `wrap` bảo vệ **đúng những lệnh đi qua nó**. Một harness gọi thẳng shell mà không qua `wrap` thì không có gì ghi, không có gì chặn.
