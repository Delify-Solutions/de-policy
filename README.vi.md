<p align="center">
  <img src="docs/banner.svg" alt="de-policy" width="720">
</p>

<h1 align="center">⚔️ de-policy — công cụ red-team cho DeepSeek Harness</h1>

<p align="center"><strong>Phiên bản 2.0.1</strong></p>

<p align="center">
  <em>Bản đầy đủ + hỗ trợ Super Agent · DSH 0.2.2-rc.3 · Prompt tối ưu, ít từ chối hơn, ổn định hơn.</em>
</p>

<p align="center">
  <a href="https://www.deepseek.com/harness/"><img src="https://img.shields.io/badge/dsh-0.2.2--rc.3-blue" alt="DSH"></a>
  <br>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=node.js&logoColor=fff" alt="Node.js">
  <img src="https://img.shields.io/badge/License-Apache--2.0-blue" alt="Apache-2.0">
</p>

<p align="center">
  <a href="./README.md">English</a> | <strong>Tiếng Việt</strong>
</p>

## Mục lục

- [de-policy là gì](#de-policy-là-gì)
- [Endpoint bắt buộc](#endpoint-bắt-buộc)
- [Yêu cầu hệ thống](#yêu-cầu-hệ-thống)
- [Cài đặt](#cài-đặt)
- [Cài thủ công (khi lệnh plugin không dùng được)](#cài-thủ-công)
- [Cập nhật](#cập-nhật)
- [Gỡ cài đặt](#gỡ-cài-đặt)
- [Sử dụng](#sử-dụng)
- [Khôi phục bản gốc](#khôi-phục-bản-gốc)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Giấy phép](#giấy-phép)

---

## de-policy là gì

**de-policy** là plugin red-team cho bản [DeepSeek Harness](https://www.deepseek.com/harness/) chính thức đã cài trên máy bạn. Bản này nhắm **DSH 0.2.2-rc.3**, hỗ trợ cả **Web** (`dsh web`) và **desktop EXE** chính thức.

Harness không chỉ chuyển tiếp prompt. Nó viết lại prompt, cổng phê duyệt, chính sách sandbox và migrate phiên ngay lúc chạy. Nếu chỉ hỏi "model có trả lời không" thì bạn đang nhầm một chặn ở tầng host thành model từ chối. Plugin này tách hai tầng đó trên chính máy bạn, để đánh giá có kiểm soát và để thấy chính sách mặc định nào đang quá chặt.

| Bạn nhận được | Nó làm gì |
|---|---|
| **Bảng điều khiển Clean** | Xem và áp dụng/gỡ từng bản vá, có bản sao lưu từng tệp |
| **Bảng diễn tập (red-team)** | 67 tool, 40 skill, 6 vai thực thi, sổ cái SQLite ghi mọi phát hiện |
| **Preset chỉ huy** | Agent điều phối biết chia việc, kiểm chứng báo cáo, chấm điểm |
| **Chỉnh prompt theo model** | Mỗi model một bộ prompt riêng, không ghi đè lẫn nhau |

---

## Endpoint bắt buộc

Bản build này chỉ chạy khi **model bạn đang chọn** được phục vụ bởi `ai.delify.vn`.

Điểm quan trọng: DSH có thể giữ **nhiều provider cùng lúc** — official, account, gateway tự dựng, lab. Câu hỏi không phải "máy này có cấu hình endpoint của mình không", mà là **"model tôi sắp chạy có phải của mình không"**. Nên gate đọc **provider đang được chọn**, rồi tra endpoint của provider đó.

Nếu DSH đang trỏ sang endpoint khác, plugin **từ chối áp dụng bản vá**.

### Nó đọc theo thứ tự

| Bước | Nguồn | Ghi chú |
|---|---|---|
| 1 | `DE_POLICY_ENDPOINT` | Bạn set để chỉ định rõ (staging, lab). Ưu tiên cao nhất |
| 2 | **Model đang chọn** | `modelSelection.lastUsed` → provider → endpoint của provider đó |
| 3 | `$DSH_HOME/redteam/config.json` | Plugin tự lưu từ EnvTab |
| 4 | `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_BASE` | Biến host đọc |

Với bước 2, endpoint của provider lấy theo thứ tự:
- `baseURL` bạn tự đặt trong profile provider (thắng `defaultBaseURL` — đây là cách trỏ gateway tự dựng về host của mình)
- `defaultBaseURL` của adapter
- biến môi trường trong `baseURLEnv`

### Ví dụ

Máy có cả `deepseek-official` (→ `api.deepseek.com`) và một gateway của Delify (→ `ai.delify.vn`):

- Chọn model qua gateway Delify → **cho phép**
- Chọn model qua `deepseek-official` → **từ chối**, banner ghi rõ provider nào và endpoint nào

Đổi model trong DSH là xong, không cần sửa cấu hình.

### Chỉ định endpoint rõ ràng

```sh
export DE_POLICY_ENDPOINT=https://ai.delify.vn
```

Hoặc **de-policy → Bảng diễn tập → Thích ứng môi trường**.

### Khi bị từ chối

Banner vàng ở đầu trang **Thích ứng môi trường**, ghi rõ: provider đang chọn, endpoint phát hiện được, và nguồn. Sửa bằng cách:

1. Đổi sang model được phục vụ bởi `ai.delify.vn`, hoặc
2. Set `DE_POLICY_ENDPOINT=https://ai.delify.vn`

**`/purge revert` luôn chạy được** dù endpoint sai — bạn không bao giờ bị kẹt với host đã vá mà không gỡ được.

---

## Yêu cầu hệ thống

| Thành phần | Yêu cầu |
|---|---|
| Node.js | **>= 22.13** (engine dùng `node:sqlite`, từ 22.13 mới không cần flag) |
| DeepSeek Harness | **0.2.2-rc.3** (bản chính thức) |
| Hệ điều hành | macOS, Windows, Linux |
| Quyền | Ghi được vào thư mục cài DSH và `$DSH_HOME` |

Kiểm tra phiên bản trước khi cài:

```sh
node -v        # phải >= 22.13
dsh --version  # phải là 0.2.2-rc.3
```

Nếu Node cũ hơn, cài bản mới trước. Plugin sẽ lỗi ngay lúc nạp nếu `node:sqlite` không có.

---

## Cài đặt

### Bước 1 — tải và giải nén

Tải file zip từ [trang Releases](https://github.com/Delify-Solutions/de-policy/releases), giải nén ra một thư mục tên `de-policy`.

```sh
# ví dụ
unzip de-policy-2.0.1.zip -d ~/plugins/
# kết quả: ~/plugins/de-policy/
```

Đường dẫn tuyệt đối của thư mục đó sẽ dùng ở bước 3. Ghi lại.

### Bước 2 — xác định profile bạn đang dùng

DSH có nhiều profile. Cài sai profile thì mở lên không thấy gì, trông y hệt như cài lỗi.

```sh
# đang chạy bản web
dsh web --version

# hoặc xem profile nào tồn tại
ls ~/.dsh/profiles/
# desktop/  web/  (có thể có tui/)
```

- Dùng **ứng dụng desktop** → profile `desktop`
- Dùng **`dsh web`** (trình duyệt) → profile `web`

### Bước 3 — thêm plugin vào profile

```sh
# nếu dùng bản web
dsh plugin --profile web add /absolute/path/to/de-policy

# nếu dùng ứng dụng desktop
dsh plugin --profile desktop add /absolute/path/to/de-policy
```

Thay `/absolute/path/to/de-policy` bằng đường dẫn thật ở bước 1.

### Bước 4 — khởi động lại DSH

Thoát **hoàn toàn** rồi mở lại. Plugin chỉ được nạp lúc khởi động.

- macOS: <kbd>Cmd</kbd>+<kbd>Q</kbd>, không chỉ đóng cửa sổ
- Windows: thoát khỏi khay hệ thống
- `dsh web`: dừng tiến trình rồi chạy lại

### Bước 5 — áp dụng bản vá

Mở DSH, bấm **de-policy** cạnh tiêu đề phiên → **Dọn dẹp** → **Áp dụng**.

Áp dụng thành công sẽ khởi động lại host một lần. Đó là bình thường.

### Bước 6 — kiểm tra

```sh
/purge status
```

Lệnh này in ra `$DSH_HOME` đang dùng và trạng thái từng bản vá. Nếu thấy danh sách bản vá đã áp dụng là xong.

<a id="cài-thủ-công"></a>

### Cài thủ công

Dùng khi lệnh `dsh plugin` không chạy được (bản DSH cũ, hoặc môi trường hạn chế).

**1.** Tìm `$DSH_HOME` đang hoạt động — thư mục có chứa `profiles/web` hoặc `profiles/desktop`.

```sh
echo $DSH_HOME          # nếu đã set
ls ~/.dsh/profiles/     # mặc định
```

**2.** Chép thư mục plugin vào:

```sh
mkdir -p "$DSH_HOME/plugins"
cp -R /absolute/path/to/de-policy "$DSH_HOME/plugins/de-policy"
```

**3.** Sửa `package.json` của profile đó — thêm vào `dependencies` và `dsh.profile.bundles`, **giữ nguyên các mục đã có**:

```jsonc
{
  "dependencies": {
    "de-policy": "file:../../plugins/de-policy"   // thêm dòng này
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "de-policy"                                // thêm dòng này
      ]
    }
  }
}
```

**4.** Cài dependency trong thư mục profile:

```sh
cd "$DSH_HOME/profiles/web"   # hoặc desktop
pnpm install
test -f node_modules/de-policy/package.json && echo "OK"
```

**5.** Khởi động lại DSH hoàn toàn, rồi **Dọn dẹp → Áp dụng**.

---

## Cập nhật

### Cách 1 — thay thế thư mục (khuyến nghị)

Dữ liệu của bạn (`$DSH_HOME`) **không** nằm trong thư mục plugin, nên thay thế không mất gì.

```sh
# 1. Gỡ bản cũ khỏi profile
dsh plugin --profile web remove de-policy

# 2. Thay thư mục
mv /absolute/path/to/de-policy /absolute/path/to/de-policy.old
unzip de-policy-2.0.2.zip -d /absolute/path/

# 3. Cài lại
dsh plugin --profile web add /absolute/path/to/de-policy
```

Khởi động lại DSH. Bản vá cũ vẫn còn trong `$DSH_HOME`, plugin mới sẽ nhận ra và không áp dụng trùng.

Xoá `de-policy.old` khi đã xác nhận bản mới chạy được.

### Cách 2 — cài đè trực tiếp

```sh
dsh plugin --profile web add /absolute/path/to/de-policy
```

Chạy lại lệnh `add` với đường dẫn mới. Package manager sẽ cập nhật. Sau đó khởi động lại DSH.

### Sau khi cập nhật

**1.** Kiểm tra phiên bản đã đúng:

```sh
node -p "require('$DSH_HOME/profiles/web/node_modules/de-policy/package.json').version"
```

**2.** Mở bảng **Dọn dẹp**, xem có bản vá nào ở trạng thái lạ không.

**3.** Nếu bản mới đổi cấu trúc bản vá, các bản vá cũ không khớp sẽ hiện **bỏ qua (skipped)**. Áp dụng vẫn hoàn tất, các tệp đó để nguyên. Đây là hành vi đúng, không phải lỗi.

**4.** Nếu bạn đã sửa `prompt-inject.md`, tệp đó **được giữ** qua mọi lần cập nhật.

### Cập nhật có phá dữ liệu không?

Không. Toàn bộ dữ liệu nằm ngoài thư mục plugin:

| Dữ liệu | Vị trí |
|---|---|
| Sổ cái red-team (asset, vuln, credential, điểm) | `$DSH_HOME/redteam/engagements/<slug>/assets.db` |
| Prompt của bạn | `$DSH_HOME/prompt-inject.md` |
| Bộ quy tắc | `$DSH_HOME/rules/` |
| Skill đã cài | `$DSH_HOME/skills/` |
| Bản sao lưu bản vá | `*.dshpurge.bak` cạnh tệp gốc |

Thay thư mục plugin không đụng tới bất kỳ mục nào ở trên.

---

## Gỡ cài đặt

```sh
# qua CLI
dsh plugin --profile web remove de-policy

# hoặc trong UI: Dọn dẹp → Gỡ cài đặt
# hoặc: /purge uninstall
```

Gỡ cài đặt sẽ **khôi phục bản gốc trước**, rồi mới xoá tệp inject, thư viện quy tắc và plugin.

Dữ liệu red-team trong `$DSH_HOME/redteam/` **không** bị xoá. Muốn xoá luôn thì làm thủ công:

```sh
rm -rf "$DSH_HOME/redteam"
```

---

## Sử dụng

| Việc | Cách |
|---|---|
| Xem/áp dụng bản vá | **de-policy** cạnh tiêu đề phiên → **Dọn dẹp** |
| Mở bảng diễn tập | **de-policy** → **Bảng diễn tập** |

### Các lệnh `/purge`

| Lệnh | Viết tắt | Việc |
|---|---|---|
| `/purge status` | `/purge s` | Xem `$DSH_HOME` đang dùng và trạng thái từng bản vá |
| `/purge apply` | `/purge a` | Áp dụng toàn bộ bản vá |
| `/purge revert` | `/purge r` | Khôi phục bản gốc từ `.dshpurge.bak` |
| `/purge uninstall` | `/purge remove` | Khôi phục rồi gỡ plugin |
| `/purge edit` | `/purge e` | Mở `prompt-inject.md` để sửa |
| `/purge help` | — | Danh sách lệnh |

**Red-team:** bấm **de-policy** → **Bảng diễn tập**, tạo engagement, rồi làm theo panel. Mỗi phát hiện phải được ghi vào sổ cái — phát hiện không nằm trong sổ cái thì không tính là đã xảy ra.

---

## Khôi phục bản gốc

- Mỗi tệp được sao lưu thành `<tên>.dshpurge.bak` trước lần áp dụng đầu tiên.
- **Khôi phục** hoặc `/purge revert` chép bản sao lưu về rồi xoá chúng. Không có bản sao lưu thì các dòng shim do plugin viết sẽ bị bóc ra.
- `prompt-inject.md` là tệp của bạn, luôn được giữ.
- Áp dụng là idempotent — chạy nhiều lần không sinh thêm lớp.

---

## Xử lý sự cố

### Mở DSH không thấy mục "de-policy"

1. **Sai profile.** Kiểm tra bạn đã cài vào profile đang chạy chưa (bước 2).
2. **Chưa khởi động lại hoàn toàn.** Đóng cửa sổ không đủ, phải thoát tiến trình.
3. **Thiếu bundle.** Kiểm tra `dsh.profile.bundles` trong `package.json` của profile có `"de-policy"`.

```sh
node -p "require('$DSH_HOME/profiles/web/package.json').dsh.profile.bundles"
```

### Lỗi `Cannot find module 'node:sqlite'`

Node cũ hơn 22.13. Nâng cấp Node:

```sh
node -v   # nếu < 22.13 thì đây là nguyên nhân
```

### Áp dụng xong nhưng không có gì thay đổi

Kiểm tra `$DSH_HOME` đang dùng có đúng chỗ bạn nghĩ không:

```sh
/purge status
```

Web và desktop dùng `$DSH_HOME` **khác nhau**. Sửa nhầm cái thì không thấy tác dụng.

### Bảng diễn tập mở nhưng tool báo `store_missing`

Store SQLite chưa khởi tạo. Tạo engagement đầu tiên trong panel Asset, store sẽ tự dựng.

### Sau khi cập nhật, một số bản vá hiện "bỏ qua"

Bản mới đổi nội dung gốc nên không khớp. Đây là hành vi đúng — tệp lạ được để nguyên thay vì vá mù. Xem ghi chú phát hành để biết bản vá nào đã đổi.

---

## Giấy phép

Sản phẩm này phát hành theo [Apache License 2.0](./LICENSE). Thông báo bản quyền của bên thứ ba mà giấy phép yêu cầu nằm trong [NOTICE](./NOTICE).

Xem [release-notes.md](./release-notes.md) cho ghi chú phát hành hiện tại.
