/**
 * Skill fix text (zero-dependency, pure ESM)
 *
 * Purpose: used by the console's skill library tab — every **unavailable** skill must be
 * able to tell the user "how to fix it", not just "what is missing". `skill-availability.js`
 * decides (missing env var / missing tool / unfilled placeholder / shadowed by a
 * same-named skill); this file turns each verdict into actionable steps:
 *   · `TOOL_FIXES`   — per-tool install method (matches `scripts/redteam-setup.sh`:
 *                      anything scriptable sends the user to that script)
 *   · `SKILL_FIXES`  — per-skill extra repair steps (FOFA_KEY, VPS address, browser ext…)
 *   · `toolNameOfPath` / `fixesForIssue` — turn "this path does not exist" into concrete
 *                      advice
 *
 * Text conventions: one sentence saying "what this is / how to supply it", commands
 * always wrapped in backticks, no invented URLs or version numbers, no markdown emphasis
 * in the body (the panel renders plain text). `fixesForIssue()` produces **single-line**
 * advice per branch (so a list item does not collapse); the `SKILL_FIXES` fallback may
 * contain newlines — skill text allows 1–3 lines.
 *
 * Policy (aligned with upstream 0.15.4): **no third-party download links, no per-tool
 * install tutorial**. A missing third-party binary is always described as "prepared by
 * the user, placed at `<path>` and `chmod +x`"; system software only gets package
 * manager commands (`apt install …`). The only automatic entry point kept is this
 * plugin's bundled `$DSH_HOME/redteam/setup.sh` — it ships with the plugin, survives a
 * machine change, and is a local repair entry rather than an external link.
 */

/** The plugin's bundled one-shot repair entry (synced to `$DSH_HOME/redteam/setup.sh`;
 *  tool downloads and FOFA_KEY/VPS guidance all live in this one script). */
const SETUP = 'bash $DSH_HOME/redteam/setup.sh --yes'

/** Fallback advice when there is no idea what is missing. */
const GENERIC_FIX = 'Người dùng chạy `' + SETUP + '` để bù tool và cấu hình (idempotent, chạy lại được nhiều lần; thiếu thì tải về, hỏng thì xóa tải lại),'
  + ' sửa `$DSH_HOME/.env` xong phải khởi động lại `dsh web` mới có hiệu lực; vẫn không được thì cài lại plugin redteam rồi kiểm tra lại.'

/** What the toolkit attachment actually ships. Never say "unpack the missing thing from
 *  the attachment". */
const TOOLKIT_TARBALL = 'gói đính kèm toolkit (hiện chỉ có README, vài file skill md và script setup, không chứa binary hay mã nguồn)'

/* -- per-tool fixes ---------------------------------------------------------- */

const FRP_FIX = {
  what: 'frp đục lỗ nội mạng: `frps` chạy trên VPS làm server, `frpc` chạy trên mục tiêu làm client (hai binary trong cùng một release)',
  install: 'chạy `' + SETUP + '` một lần để giải nén `frpc` + `frps` vào `$DSH_HOME/redteam/toolkit/frp/`;'
    + ' nếu script không phủ thì tự chuẩn bị binary `frpc`/`frps` đúng nền tảng, đặt vào cùng thư mục và `chmod +x`',
}

const LIGOLO_FIX = {
  what: 'ligolo-ng tunnel TUN (`proxy` phía server + `agent` phía mục tiêu), kênh dự phòng ngoài chisel/frp, cần root để tạo card mạng ảo',
  install: 'chạy `' + SETUP + '` để cài vào `$DSH_HOME/redteam/toolkit/ligolo/proxy` và `.../ligolo/agent`;'
    + ' hoặc tự chuẩn bị binary `proxy` / `agent`, đặt đúng tên trên vào `toolkit/ligolo/` và `chmod +x`',
}

export const TOOL_FIXES = {
  /* -- binaries setup.sh downloads into toolkit/ -- */
  fscan: {
    what: 'Quét tổng hợp nội mạng (sống/port/nhận diện dịch vụ/28 loại mật khẩu yếu/truy cập trái phép/lỗ hổng nguy hiểm, v2.2.1)',
    install: 'chạy `' + SETUP + '` để bù vào `$DSH_HOME/redteam/toolkit/fscan/fscan`;'
      + ' nếu chỉ tải được `fscan.zip` mà chưa giải nén, giải nén thủ công lấy binary `fscan` rồi `chmod +x`; script vẫn không bù được thì tự chuẩn bị binary đúng nền tảng (kể cả bản Windows / arm64) đặt vào thư mục đó',
  },
  gogo: {
    what: 'Engine quét và fingerprint nội mạng (v2.15.0, fingerprint chủ động + thụ động, trích xuất thông tin quan trọng, POC template nuclei)',
    install: 'setup.sh với gogo chỉ đưa gợi ý, không tự tải (tên asset upstream không cố định): chạy `' + SETUP + '` xem gợi ý,'
      + ' rồi tự chuẩn bị binary đúng nền tảng, chương trình chính đặt `$DSH_HOME/redteam/toolkit/gogo/gogo`, bản Windows/arm64 (`gogo_windows_amd64.exe`, `gogo_linux_arm64`) đặt cùng thư mục, tất cả `chmod +x`',
  },
  suo5: {
    what: 'suo5: công cụ lõi đột phá nội mạng dựng tunnel SOCKS5 qua WebShell/HTTP (v2.2.0, Go tĩnh không phụ thuộc)',
    install: 'chạy `' + SETUP + '` để cài vào `$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64`;'
      + ' hoặc tự chuẩn bị `suo5-linux-amd64` đặt vào đường dẫn đó và `chmod +x`',
  },
  chisel: {
    what: 'chisel tunnel HTTP (server và client là cùng một binary, v1.12.0)',
    install: 'chạy `' + SETUP + '` để cài vào `$DSH_HOME/redteam/toolkit/chisel/chisel`;'
      + ' hoặc tự chuẩn bị binary `chisel` biên dịch tĩnh và `chmod +x`',
  },
  frp: FRP_FIX,
  frpc: FRP_FIX,
  frps: FRP_FIX,
  subfinder: {
    what: 'Liệt kê subdomain thụ động (ProjectDiscovery, v2.16.0, tổng hợp nhiều nguồn)',
    install: 'chạy `' + SETUP + '` để cài vào `$DSH_HOME/redteam/toolkit/subfinder/subfinder`;'
      + ' hoặc tự chuẩn bị binary đúng nền tảng, đặt vào đó và `chmod +x`',
  },
  dnsx: {
    what: 'Phân giải/brute DNS hàng loạt/lọc wildcard (ProjectDiscovery, v1.3.1)',
    install: 'chạy `' + SETUP + '` để cài vào `$DSH_HOME/redteam/toolkit/dnsx/dnsx`;'
      + ' hoặc tự chuẩn bị binary đúng nền tảng, đặt vào đó và `chmod +x`',
  },
  naabu: {
    what: 'Quét port tốc độ cao (ProjectDiscovery, v2.6.1; SYN cần root, không root thì thêm `-scan-type c`)',
    install: 'chạy `' + SETUP + '` để cài vào `$DSH_HOME/redteam/toolkit/naabu/naabu`;'
      + ' hoặc tự chuẩn bị binary đúng nền tảng, đặt vào đó và `chmod +x`',
  },
  httpx: {
    what: 'Dò sống/chết HTTP, title, mã trạng thái, stack công nghệ (bản ProjectDiscovery, v1.12.0; `/usr/bin/httpx` là CLI của thư viện httpx Python, không phải cái này)',
    install: 'chạy `' + SETUP + '` để cài vào `$DSH_HOME/redteam/toolkit/httpx/httpx`;'
      + ' hoặc tự chuẩn bị binary đúng nền tảng, đặt vào đó và `chmod +x`;'
      + ' trên dòng lệnh hãy gọi qua script bọc `pd-httpx` (xem mục `pd-httpx`)',
  },
  ksubdomain: {
    what: 'Brute subdomain không trạng thái (knownsec ksubdomain v0.7, nhanh hơn brute bằng dnsx, cần root để gửi gói)',
    install: 'chạy `' + SETUP + '` để cài vào `$DSH_HOME/redteam/toolkit/ksubdomain/ksubdomain`;'
      + ' hoặc tự chuẩn bị binary đúng nền tảng, đặt vào đó và `chmod +x`',
  },
  ligolo: LIGOLO_FIX,
  'ligolo-proxy': LIGOLO_FIX,
  'ligolo-agent': LIGOLO_FIX,
  gowitness: {
    what: 'Chụp ảnh hàng loạt trang web để lưu chứng cứ (sensepost/gowitness)',
    install: 'chạy `' + SETUP + '` để cài vào `$DSH_HOME/redteam/toolkit/gowitness/gowitness`;'
      + ' hoặc tự chuẩn bị binary đúng nền tảng, đặt vào đó và `chmod +x` —— '
      + 'lưu ý bản tải về phải đầy đủ (file binary bị cắt cụt vẫn tồn tại và quyền đúng, nhưng chạy thì không ra gì)',
  },
  oneforall: {
    what: 'Bộ thu thập subdomain OneForAll (v0.4.5, mã nguồn + `.venv`, chậm nhưng đầy đủ)',
    install: 'chạy `' + SETUP + '` sẽ đưa mã nguồn vào `$DSH_HOME/redteam/toolkit/oneforall/OneForAll-0.4.5/` và tạo `.venv` với dependencies;'
      + ' không cài được cũng không ảnh hưởng tuyến chính —— dùng `subfinder` + `ksubdomain` thay thế',
  },
  vps: {
    what: 'Cách đăng nhập VPS (`REDTEAM_VPS_HOST` / `REDTEAM_VPS_KEY`) và script trung chuyển `vps.sh`: đầu nhận của reverse Shell, phân phối payload, đầu ra tunnel',
    install: 'chạy `' + SETUP + '` sẽ hướng dẫn ghi địa chỉ VPS và đường dẫn private key; private key đặt `$DSH_HOME/redteam/toolkit/vps/id_rsa` và `chmod 600` (kiểm tra kết nối bằng '
      + '`ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes <user>@<ip> \'echo ok\'`);'
      + ' script `$DSH_HOME/redteam/toolkit/vps/vps.sh` không có trong gói đính kèm toolkit: tự viết thành script thực thi theo các lệnh con của skill `vps-reverse-shell` (tối thiểu phải có `serve <port>` và `exec`) rồi `chmod +x`',
  },
  'nuclei-templates': {
    what: 'Thư viện template nuclei (13,000+ template, `nuclei -t` và `redteam_poc_search` đều dựa vào nó)',
    install: 'chạy `' + SETUP + '` sẽ cài vào `~/.local/nuclei-templates`; cũng có thể chạy riêng `nuclei -update-templates` (tần suất không quá một lần mỗi tuần);'
      + ' số template dưới 1000 nghĩa là chưa tải đủ, chạy lại một lần và `nuclei -tl` xác nhận thư viện không hỏng',
  },

  /* -- referenced by skills, not downloaded by setup.sh, not in the toolkit attachment -- */
  dirsearch: {
    what: 'Brute thư mục/file (Python, v0.5.0, từ điển đầy đủ, báo cáo thân thiện, kèm runtime có sẵn)',
    install: 'không nằm trong danh sách tải của setup.sh: tự chuẩn bị mã nguồn, đặt vào `$DSH_HOME/redteam/toolkit/dirsearch/` '
      + '(bảo đảm `toolkit/dirsearch/dirsearch` chạy được, `chmod +x`); tạm thời có thể dùng `feroxbuster` / `ffuf` / `gobuster` thay thế',
  },
  behinder: {
    what: 'Client Behinder v4.1 + mẫu webshell mã hóa (`toolkit/Behinder/server/*.jsp|php|aspx`, lực lượng chính để triển khai WebShell)',
    install: 'setup.sh không tải: ' + TOOLKIT_TARBALL + ', nên tự chuẩn bị client, đặt vào `toolkit/Behinder/`;'
      + ' nếu chỉ cần mẫu webshell thì giữ đủ bảy mẫu trong `toolkit/Behinder/server/` (không có GUI vẫn dùng `sed` đổi key để sinh được); cần `java -jar` nên máy phải có Java',
  },
  godzilla: {
    what: 'Client Godzilla v4.0.1 (`godzilla.jar`, GUI sinh payload mã hóa toàn bộ JSP/PHP/ASPX)',
    install: 'setup.sh không tải: ' + TOOLKIT_TARBALL + ', nên tự chuẩn bị `godzilla.jar`, đặt vào `toolkit/Godzilla/`;'
      + ' khởi động cần Java (`apt install openjdk-17-jre`) và phiên đồ họa (`DISPLAY=:10.0`)',
  },
  antsword: {
    what: 'AntSword (Loader + thư mục mã nguồn, lần đầu khởi động phải chọn thư mục mã nguồn `antSword-2.1.16`)',
    install: 'setup.sh không tải: ' + TOOLKIT_TARBALL + ', nên tự chuẩn bị Loader và thư mục mã nguồn, đặt vào `toolkit/AntSword/` ('
      + '`toolkit/AntSword/AntSword-Loader-v4.0.3-linux-x64/AntSword` phải chạy được)',
  },
  netexec: {
    what: 'netexec (nxc) công cụ ngang nội mạng/liệt kê giao thức (`toolkit/netexec/`, trên Kali cũng có thể `apt install netexec`)',
    install: '`apt install netexec`; bản trong toolkit máy này ở `$DSH_HOME/redteam/toolkit/netexec/`,'
      + ' thiếu thì cài theo tài liệu chính thức bằng `pipx install netexec`; đừng chờ giải nén từ ' + TOOLKIT_TARBALL,
  },

  /* -- local scripts/binaries that appear in skills and setup.sh does not handle -- */
  'pd-httpx': {
    what: 'Script bọc cho httpx của ProjectDiscovery (`~/.local/bin/pd-httpx`) —— tránh trùng tên với CLI của thư viện httpx Python',
    install: 'chạy `' + SETUP + '` trước để cài `$DSH_HOME/redteam/toolkit/httpx/httpx`, rồi dựng lại script bọc và cấp quyền:'
      + ' `printf \'#!/usr/bin/env bash\\nexec "\${DSH_HOME:-$HOME/.dsh}/redteam/toolkit/httpx/httpx" "$@"\\n\' > ~/.local/bin/pd-httpx && chmod +x ~/.local/bin/pd-httpx`',
  },
  'kimi-chrome': {
    what: 'Script khởi chạy trình duyệt "có thể bị extension Kimi WebBridge điều khiển" (`~/.local/bin/kimi-chrome`)',
    install: 'cài trình duyệt trước: `apt install google-chrome-stable` (hoặc `apt install chromium`); rồi tạo `~/.local/bin/kimi-chrome`:'
      + ' mặc định `exec /usr/bin/google-chrome --no-first-run --no-default-browser-check "$@"`, khi `KIMI_BROWSER=chromium` thì dùng `/usr/bin/chromium`,'
      + ' đầu script tiện thể chạy `systemctl start kimi-webbridge` để kéo daemon lên, cuối cùng `chmod +x ~/.local/bin/kimi-chrome`',
  },
  'kimi-webbridge': {
    what: 'Daemon cục bộ Kimi WebBridge (dịch vụ systemd `kimi-webbridge`, lắng nghe `127.0.0.1:10086`, skill dựa vào nó để điều khiển trình duyệt thật)',
    install: 'daemon ở `~/.kimi-webbridge/bin/kimi-webbridge`, do `/etc/systemd/system/kimi-webbridge.service` quản lý:'
      + ' sau khi cài lại thì `sudo systemctl enable --now kimi-webbridge`, rồi dùng `~/.kimi-webbridge/bin/kimi-webbridge status` xác nhận `"running": true`;'
      + ' extension trình duyệt được chính sách doanh nghiệp tự cài từ Chrome Web Store (ID `fldmhceldgbpfpkbgopacenieobmligc`), Chrome 137+ không dùng cách load giải nén',
  },
  chromium: {
    what: 'Trình duyệt Chromium (phương án không phụ thuộc để lấy DOM sau render / chụp ảnh / tạo PDF ở headless, `/usr/bin/chromium`)',
    install: '`apt install chromium` (cũng có thể cài `google-chrome-stable`); cách dùng: `/usr/bin/chromium --headless=new --no-sandbox --dump-dom <url>`,'
      + ' chụp ảnh thì thêm `--screenshot=runs/shot.png`',
  },
  'playwright-cli': {
    what: 'Playwright CLI (tự động hóa trình duyệt khi cần click/chờ/nhiều tab, `npx --yes @playwright/cli@latest`)',
    install: '`npx --yes @playwright/cli@latest`; thiếu trình duyệt thì chạy `npx playwright install chromium`;'
      + ' khi gọi nhất thiết phải thêm `--browser chromium` (mặc định đi kênh chrome sẽ báo `Chromium distribution \'chrome\' is not found`)',
  },

  /* -- system tools (setup.sh only checks them; install via apt when missing) -- */
  nmap: {
    what: 'Quét port/dịch vụ/script (Kali có sẵn, lực lượng chính khi quét chủ động)',
    install: '`apt install nmap`; quét SYN (`-sS`) cần `sudo`, không có quyền thì dùng `-sT`',
  },
  masscan: {
    what: 'Quét port tốc độ cực cao (quét diện rộng dải mạng lớn, ồn ào)',
    install: '`apt install masscan`; gửi gói cần root, nhất thiết giới hạn `--rate` và phạm vi được phép trước',
  },
  nuclei: {
    what: 'Quét lỗ hổng theo template (lực lượng chính phát hiện Nday/1day, máy này ở `/usr/bin/nuclei`)',
    install: '`apt install nuclei`; cài xong bù luôn thư viện template: `nuclei -update-templates` (template ở `~/.local/nuclei-templates`)',
  },
  sqlmap: {
    what: 'Phát hiện và khai thác SQL injection',
    install: '`apt install sqlmap`',
  },
  ffuf: {
    what: 'Web fuzz / brute thư mục (nhanh và linh hoạt nhất, hỗ trợ nhiều từ điển, vhost, fuzz tham số)',
    install: '`apt install ffuf`',
  },
  feroxbuster: {
    what: 'Brute thư mục đệ quy (Rust, tự đi theo cấp thư mục, lựa chọn đầu tiên khi brute thư mục)',
    install: '`apt install feroxbuster`',
  },
  gobuster: {
    what: 'Brute thư mục/DNS/vhost nhẹ (ba chế độ dir/dns/vhost)',
    install: '`apt install gobuster`',
  },
  hydra: {
    what: 'Brute mật khẩu yếu trực tuyến (50+ giao thức: SSH/FTP/RDP/SMB/MySQL/MSSQL/form Web)',
    install: '`apt install hydra`',
  },
  john: {
    what: 'John the Ripper bẻ khóa hash offline (hướng CPU, hợp với từ điển nhỏ/rule)',
    install: '`apt install john`; thiếu từ điển thì `apt install wordlists` rồi `gunzip /usr/share/wordlists/rockyou.txt.gz`',
  },
  hashcat: {
    what: 'hashcat bẻ khóa hash/mật khẩu offline (ưu tiên GPU, CPU sẽ rất chậm)',
    install: '`apt install hashcat`; trước tiên `hashcat --identify hashes.txt` xác nhận số mode (ví dụ NTLM `-m 1000`, Kerberoast `-m 13100`)',
  },
  wpscan: {
    what: 'Quét lỗ hổng và liệt kê người dùng WordPress',
    install: '`apt install wpscan`; cần cơ sở dữ liệu lỗ hổng thì theo gợi ý chạy `wpscan --update`',
  },
  nikto: {
    what: 'Quét cấu hình và vấn đề đã biết của web server',
    install: '`apt install nikto`',
  },
  whatweb: {
    what: 'Nhận diện fingerprint Web (CMS/framework/middleware/phiên bản)',
    install: '`apt install whatweb`',
  },
  amass: {
    what: 'Liệt kê subdomain và quét tài sản (OWASP Amass)',
    install: '`apt install amass`; chế độ thụ động `amass enum -passive -d <domain>`',
  },
  theharvester: {
    what: 'Thu thập email/subdomain/host từ nguồn công khai (theHarvester)',
    install: '`apt install theharvester`',
  },
  msfconsole: {
    what: 'Framework Metasploit (`exploit/multi/handler` nhận reverse Shell, `web_delivery` phân phối payload)',
    install: '`apt install metasploit-framework` (cung cấp `msfconsole`); lần đầu dùng thì `msfdb init` trước',
  },
  searchsploit: {
    what: 'Tra cứu Exploit-DB cục bộ (tìm POC công khai theo thành phần/phiên bản)',
    install: '`apt install exploitdb` (cung cấp `searchsploit`); cập nhật cơ sở dữ liệu bằng `searchsploit -u`',
  },
  proxychains4: {
    what: 'Đưa lưu lượng TCP của một lệnh đơn vào nội mạng qua proxy (dùng kèm tunnel socks5)',
    install: '`apt install proxychains4`; chỉ dùng `-f` trỏ tới cấu hình tạm trong `runs/` (ví dụ `proxychains4 -f runs/proxychains-1080.conf ...`), không sửa `/etc/proxychains4.conf`',
  },
  socat: {
    what: 'Lắng nghe reverse Shell TTY đầy đủ / chuyển tiếp port (ổn định hơn nc, lấy được PTY)',
    install: '`apt install socat`',
  },
  nc: {
    what: 'netcat: lắng nghe reverse Shell và kiểm tra kết nối (`nc -lvnp <port>`)',
    install: '`apt install netcat-traditional` (cung cấp `nc`; bản Debian cũng có `netcat-openbsd`)',
  },
  tmux: {
    what: 'Giữ phiên: listener và tunnel bắt buộc chạy trong tmux, nếu không SSH ngắt là mất',
    install: '`apt install tmux`; cách dùng: `tmux new -s handler`, `tmux a -t handler`',
  },
  impacket: {
    what: 'Bộ giao thức Impacket (PtH/PsExec/WMI/DCOM/Kerberos/dump credential, Kali có sẵn 61 lệnh `impacket-*`)',
    install: '`apt install python3-impacket`; lệnh thường dùng `impacket-wmiexec` / `impacket-psexec` / `impacket-secretsdump` / `impacket-GetNPUsers`',
  },
  enum4linux: {
    what: 'Liệt kê thông tin SMB/môi trường domain (người dùng, share, nhóm, chính sách mật khẩu)',
    install: '`apt install enum4linux` (bản mới còn có `enum4linux-ng`)',
  },
  'redis-cli': {
    what: 'Client Redis (dò chỉ đọc với Redis chưa xác thực và ghi webshell)',
    install: '`apt install redis-tools` (cung cấp `redis-cli`)',
  },
  mysql: {
    what: 'Client MySQL/MariaDB (lấy dữ liệu khi MySQL chưa xác thực/mật khẩu yếu)',
    install: '`apt install default-mysql-client` (trên Kali là `mariadb-client`)',
  },
}

/* -- per-skill fixes ---------------------------------------------------------- */

export const SKILL_FIXES = {
  'active-scan': 'Cài scanner: `apt install nmap masscan`; thiếu `toolkit/naabu/naabu` thì chạy `' + SETUP + '`.'
    + ' Không phải root thì thêm `-scan-type c` cho naabu, quét SYN của nmap/masscan bắt buộc `sudo`; trước khi quét xác nhận mục tiêu nằm trong phạm vi được phép.',

  'host-post-exploit': 'Skill thuần thao tác (lục file trên host Linux/Windows, thu credential, leo thang đặc quyền, Web/DB/share cục bộ), không phụ thuộc tool ngoài và không đọc biến môi trường;'
    + ' nó chỉ gọi hai tool `redteam_host` / `redteam_next_action`. Không dùng được thường là do thiếu file skill hoặc plugin phiên bản cũ —— cài lại plugin rồi khởi động lại host hiện tại.',

  'asset-deep-scan': 'Skill thuần thao tác (đào sâu một tài sản theo năm mục surface/web/auth/cve/app), không phụ thuộc tool ngoài và không đọc biến môi trường;'
    + ' nó chỉ gọi hai tool `redteam_asset` / `redteam_asset_next`; mục cve sẽ dùng `redteam_poc_search` (thiếu template nuclei vẫn tra được knowledge base).'
    + ' Không dùng được thường là do thiếu file skill hoặc plugin phiên bản cũ —— cài lại plugin rồi khởi động lại host hiện tại.',
  'asset-correlation': 'Skill thuần ghi/liên kết dữ liệu, không phụ thuộc tool ngoài và không đọc biến môi trường; không dùng được thường là do thiếu file skill hoặc plugin phiên bản cũ —— '
    + 'cài lại plugin redteam rồi khởi động lại `dsh web`, sau đó xác nhận tool `redteam_asset_link` dùng được.',

  'browser-automation': 'Cài trình duyệt: `apt install chromium` (hoặc `google-chrome-stable`); theo hướng playwright thì thêm `npx playwright install chromium`.'
    + ' Khi gọi nhất thiết phải thêm `--browser chromium` (mặc định đi kênh chrome sẽ báo `Chromium distribution \'chrome\' is not found`).',

  'campaign-planning': 'Skill thuần lập kế hoạch, không phụ thuộc tool ngoài và không đọc biến môi trường; không dùng được thường là do thiếu file skill —— '
    + 'cài lại plugin rồi khởi động lại host hiện tại. Trước khi bắt đầu xác định mục tiêu/phạm vi/time box/ngân sách nhiễu/điều kiện dừng, rồi mới điều vai thực thi.',

  'chisel-tunnel': 'Bù binary `toolkit/chisel/chisel`: chạy `' + SETUP + '`.\n'
    + 'Hai đầu tunnel cần VPS: xác nhận `$DSH_HOME/.env` có `REDTEAM_VPS_HOST` / `REDTEAM_VPS_USER` / `REDTEAM_VPS_KEY`,'
    + ' trước lệnh chạy `set -a; . "$DSH_HOME/.env"; set +a`; sửa `.env` xong bắt buộc khởi động lại `dsh web`, nhớ mở port tunnel trên security group.',

  'cn-proxy-pool': 'Chỉ phụ thuộc `curl` / `python3` (thiếu thì `apt install curl`); không dùng được phần lớn là do thiếu file skill —— cài lại plugin rồi khởi động lại `dsh web`.'
    + ' Proxy chỉ định bằng `-proxy` / `-x` / `--proxy` trên từng lệnh, không động vào proxy hệ thống của máy hay `/etc/proxychains4.conf`.',

  'credential-attack': '`apt install hydra hashcat john`; từ điển thì `sudo apt install wordlists` rồi `gunzip /usr/share/wordlists/rockyou.txt.gz`.'
    + ' Máy không có GPU thì `hashcat` rất chậm, ưu tiên từ điển nhỏ + rule (`-r /usr/share/hashcat/rules/best64.rule`).',

  'deepseek-web-intel': 'Cấu hình `DEEPSEEK_API_KEY`: ghi vào `$DSH_HOME/.env` (không ghi vào repo/lệnh/báo cáo), sau đó khởi động lại host hiện tại.'
    + ' Không có key thì skill này không dùng được, các skill khác không bị ảnh hưởng. Kết quả truy vấn ghi ra file, cấm ghi key vào báo cáo hay dòng lệnh.',

  'dir-bruteforce': '`apt install feroxbuster ffuf gobuster`; `toolkit/dirsearch/dirsearch` không nằm trong danh sách tải của setup.sh —— '
    + 'tự chuẩn bị mã nguồn đặt vào `$DSH_HOME/redteam/toolkit/dirsearch/` và bảo đảm chạy được.',

  'fofa-recon': 'Cấu hình `FOFA_KEY`: đăng nhập <https://fofa.info> → trung tâm cá nhân → API Key.\n'
    + 'Ghi vào `$DSH_HOME/.env` (`FOFA_KEY=key_của_bạn`, `chmod 600`) hoặc tạm thời `export FOFA_KEY=…`, rồi khởi động lại `dsh web` mới có hiệu lực trong tiến trình này;'
    + ' tự kiểm tra `curl -s "https://fofa.info/api/v1/info/my?key=$FOFA_KEY"` phải trả về `"error":false`.\n'
    + 'Cũng có thể để người dùng chạy `' + SETUP + '` (script ghi hộ và kiểm tra ngay tại chỗ).',

  'frp-tunnel': 'Bù `toolkit/frp/frps`, `toolkit/frp/frpc`: chạy `' + SETUP + '` (một lần giải nén ra hai binary).\n'
    + 'Phía VPS cần `REDTEAM_VPS_HOST` / `REDTEAM_VPS_KEY` (`$DSH_HOME/.env`), trước lệnh chạy `set -a; . "$DSH_HOME/.env"; set +a`,'
    + ' sửa xong khởi động lại `dsh web`, và mở port lắng nghe của frps trên security group của cloud.',

  'fscan-intranet': 'Bù `toolkit/fscan/fscan`: chạy `' + SETUP + '`; nếu chỉ tải được `fscan.zip`, giải nén thủ công lấy `fscan` rồi `chmod +x`.\n'
    + '`<你的VPS_IP>` trong nội dung skill là placeholder: ghi `REDTEAM_VPS_HOST=<IP_thật>` vào `$DSH_HOME/.env` rồi khởi động lại `dsh web`,'
    + ' hoặc sửa trực tiếp `$DSH_HOME/skills/fscan-intranet.md` thay `<你的VPS_IP>` bằng địa chỉ thật (dịch vụ payload: chạy `vps.sh serve 9100` trên VPS).',

  'gogo-intranet': '`gogo` không được setup.sh tự tải: tự chuẩn bị binary đúng nền tảng,'
    + ' đặt vào `$DSH_HOME/redteam/toolkit/gogo/gogo` (bản Windows/arm64 đặt cùng thư mục) và `chmod +x`.\n'
    + 'Placeholder `<你的VPS_IP>` điền theo cách của `fscan-intranet`: ghi `REDTEAM_VPS_HOST` trong `.env` rồi khởi động lại `dsh web`,'
    + ' hoặc sửa trực tiếp `$DSH_HOME/skills/gogo-intranet.md` để thay placeholder.',

  'kimi-webbridge': 'Hai việc: extension trình duyệt + launcher. Extension do chính sách doanh nghiệp tự cài từ Chrome Web Store (ID `fldmhceldgbpfpkbgopacenieobmligc`),'
    + ' Chrome 137+ không dùng `--load-extension` nữa; không có Chrome/Chromium thì `apt install chromium` hoặc cài `google-chrome-stable` trước.\n'
    + 'Tạo launcher `~/.local/bin/kimi-chrome` (mặc định khởi `/usr/bin/google-chrome`, `KIMI_BROWSER=chromium` thì chuyển sang Chromium) và `chmod +x`;'
    + ' kéo daemon lên bằng `sudo systemctl enable --now kimi-webbridge`.\n'
    + 'Khi `curl -s http://127.0.0.1:10086/status` báo `extension_connected` là `false`, mở trình duyệt trước (`kimi-chrome`) rồi kiểm tra lại.',

  'lateral-movement': '`apt install python3-impacket enum4linux smbclient` (Kali có sẵn 61 lệnh `/usr/bin/impacket-*`); bẻ khóa offline `apt install hashcat`.'
    + ' Mọi lệnh tới mục tiêu nội mạng đều phải đi qua tunnel: `proxychains4 -f runs/proxychains-<port>.conf ...`, không sửa cấu hình `proxychains` hệ thống.',

  'nuclei-scan': '`apt install nuclei`; thư viện template `~/.local/nuclei-templates` thiếu thì `nuclei -update-templates` (chạy `' + SETUP + '` cũng cài).'
    + ' Sau khi cập nhật, chạy `nuclei -tl` xác nhận thư viện không hỏng, số template dưới 1000 nghĩa là chưa tải đủ.',

  'passive-recon': 'Chỉ phụ thuộc `curl` / `dig` / `jq`: `apt install curl dnsutils jq`; skill này không cần API key nào.'
    + ' Không dùng được thường là do thiếu file skill hoặc plugin phiên bản cũ —— cài lại plugin rồi khởi động lại `dsh web`.',

  'recon-pipeline': 'Bù toolkit một lần: chạy `' + SETUP + '` (subfinder / dnsx / naabu / httpx / ksubdomain đều trong đó).\n'
    + '`~/.local/bin/pd-httpx` là script bọc trỏ tới `toolkit/httpx/httpx`, thiếu thì dựng lại theo `TOOL_FIXES["pd-httpx"]`;'
    + ' OneForAll không cài được cũng không ảnh hưởng tuyến chính, dùng subfinder + ksubdomain thay thế.',

  'score-coverage': 'Skill tra cứu nhanh (nhận diện/điểm vào/chứng cứ của 25 loại điểm số), không phụ thuộc tool ngoài và không đọc biến môi trường;'
    + ' không dùng được thường là do thiếu file skill hoặc plugin phiên bản cũ —— cài lại plugin rồi khởi động lại host hiện tại.',

  'specialist-paths': 'Skill thuần tra cứu, không phụ thuộc tool ngoài và không đọc biến môi trường; không dùng được thường là do thiếu file skill —— '
    + 'cài lại plugin rồi khởi động lại host hiện tại. Trước tiên chọn đường theo loại tài sản: AD/định danh, thiết bị biên, cloud/K8s, IoT/OT, file backup hay AI/Agent, rồi tra code của score-coverage.',

  'redteam-setup': 'Script môi trường ở `$DSH_HOME/redteam/setup.sh`; không có file này nghĩa là bản cài rút gọn (bản npm), skill và script do người dùng tự chuẩn bị.\n'
    + 'Cấu hình xong `FOFA_KEY` và VPS thì khởi động lại `dsh web`, và ghi dấu hoàn tất: `mkdir -p "$DSH_HOME/redteam" && date -Is > "$DSH_HOME/redteam/.setup-complete"`, cuối cùng chạy lại `redteam_preflight` để rà soát.',

  'shell-handler': 'Tool lắng nghe trên máy: `apt install netcat-traditional socat tmux` (theo hướng MSF thì thêm `apt install metasploit-framework`).\n'
    + 'Biến VPS đọc từ `$DSH_HOME/.env`: trước lệnh chạy `set -a; . "$DSH_HOME/.env"; set +a`; thiếu `REDTEAM_VPS_HOST` thì chạy `' + SETUP + '` để bù,'
    + ' sửa `.env` xong bắt buộc khởi động lại `dsh web`. Listener luôn đặt trong tmux, đừng để SSH ngắt mang theo phiên.',

  'suo5-tunnel': 'Bù `toolkit/suo5/suo5-linux-amd64`: chạy `' + SETUP + '` (hoặc tự chuẩn bị binary cùng tên) và `chmod +x`.\n'
    + 'Đầu ra/trung chuyển tunnel phụ thuộc VPS: cấu hình `REDTEAM_VPS_HOST` / `REDTEAM_VPS_KEY` trong `$DSH_HOME/.env` rồi khởi động lại `dsh web`;'
    + ' WebShell ở đầu vào tunnel phải là webshell Behinder/Godzilla (xem skill `webshell-toolkit`), nếu không người dùng không tái sử dụng được.',

  'unauth-exploit': 'Cài client: `apt install redis-tools default-mysql-client python3-impacket` (MSSQL dùng `impacket-mssqlclient`).\n'
    + 'Mục tiêu nội mạng cần tunnel: `apt install proxychains4` rồi dùng `-f runs/proxychains-<port>.conf`, hoặc dựng socks5 trước theo skill `suo5-tunnel`;'
    + ' khi chưa cấu hình `REDTEAM_VPS_HOST`, các bước phụ thuộc VPS sẽ bị đánh giá là không dùng được.',

  'vps-reverse-shell': 'Điền VPS: chạy `' + SETUP + '` để được hướng dẫn ghi `REDTEAM_VPS_HOST` (`<user>@<host>`) và `REDTEAM_VPS_KEY` (đường dẫn private key, mặc định `$DSH_HOME/redteam/toolkit/vps/id_rsa`).\n'
    + 'Cũng có thể ghi thủ công `$DSH_HOME/.env` rồi khởi động lại `dsh web`, hoặc sửa trực tiếp `$DSH_HOME/skills/vps-reverse-shell.md`, thay `<你的VPS_IP>` / `<VPS 主机名>` bằng địa chỉ thật.\n'
    + 'Private key bắt buộc `chmod 600`, kiểm tra kết nối bằng `ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes <user>@<ip> \'echo ok\'`; mở port 22 và 9000-9999 trên security group.',

  'web-fingerprint': 'Thiếu `~/.local/bin/pd-httpx` thì dựng lại theo `TOOL_FIXES["pd-httpx"]` (nó exec `toolkit/httpx/httpx`);'
    + ' thiếu `nuclei` thì `apt install nuclei`, thư viện template nhận diện công nghệ bù bằng `nuclei -update-templates`.',

  'webshell-toolkit': '`toolkit/Behinder`, `toolkit/Godzilla`, `toolkit/AntSword` không có trong setup.sh, cũng không có trong ' + TOOLKIT_TARBALL + ':'
    + ' tự chuẩn bị và đặt vào thư mục tương ứng.\n'
    + 'GUI cần Java và phiên đồ họa: xác nhận `java -version` (thiếu thì `apt install openjdk-17-jre`), `DISPLAY=:10.0`;'
    + ' không có GUI thì dùng `sed` đổi key để sinh trực tiếp webshell Behinder (mẫu ở `toolkit/Behinder/server/`).',
}

/* -- internal helpers -------------------------------------------------------- */

/** Common extensions (`fscan_windows_x64.exe`, `vps.sh`, `godzilla.jar` …). */
const EXT_RE = /\.(exe|zip|tar\.gz|tgz|gz|bz2|xz|jar|sh|py|bin|txt|md|json)$/i
/** Platform suffixes (`_windows_x64`, `-linux-amd64`, `_darwin_arm64` …). */
const PLATFORM_RE = /[-_](windows|win32|win64|win|linux|darwin|macos|osx|freebsd)[-_][a-z0-9_.]+$/
/** Architecture suffixes (bare `_amd64` / `-arm64`). */
const ARCH_RE = /[-_](amd64|x86_64|x64|arm64|aarch64|arm|386|i386|i686|mips[a-z0-9]*)$/

/**
 * Reduce a binary/dir name to a tool name: strip extension, platform and arch suffixes,
 * lowercase. If nothing ASCII-letter remains (e.g. a pure-symbol or non-ASCII name),
 * return null — then it is not a tool name.
 */
function cleanToolName(raw) {
  let out = String(raw == null ? '' : raw).trim()
  if (out === '') return null
  out = out.replace(EXT_RE, '')
  let prev = ''
  while (out !== '' && out !== prev) {
    prev = out
    out = out.replace(PLATFORM_RE, '').replace(ARCH_RE, '')
  }
  out = out.toLowerCase()
  return /[a-z]/.test(out) ? out : null
}

/**
 * Extract a tool name from a path (null when not extractable).
 *   · `…/redteam/toolkit/<tool>/…` → the first dir after `toolkit/` (`suo5-linux-amd64` → `suo5`)
 *   · `~/.local/bin/xxx`, `/usr/bin/xxx`, `~/.local/xxx` → the filename
 *   · a bare name (`fscan_windows_x64.exe`, `gogo_linux_arm64`) → name minus platform suffix
 *   · any other path (`/usr/share/wordlists/rockyou.txt`, `skills/x.md`) → null
 */
export function toolNameOfPath(p) {
  if (typeof p !== 'string') return null
  const s = p.trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[，。；、：,;:)\]}>）】]+$/, '')
    .replace(/\\/g, '/')
  if (s === '') return null
  let candidate = null
  const at = s.lastIndexOf('toolkit/')
  if (at !== -1) {
    candidate = s.slice(at + 'toolkit/'.length).split('/').filter((seg) => seg !== '')[0] || null
  } else if (/\/bin\//.test(s) || /(^|\/)\.local\//.test(s)) {
    const segs = s.split('/').filter((seg) => seg !== '')
    candidate = segs.length > 0 ? segs[segs.length - 1] : null
  } else if (!s.includes('/')) {
    candidate = s
  }
  return candidate === null ? null : cleanToolName(candidate)
}

/** Alias normalization: commands like `impacket-wmiexec` map to the `impacket` fix. */
function canonicalTool(name) {
  const n = String(name || '')
  if (n.startsWith('impacket-')) return 'impacket'
  if (n.startsWith('enum4linux-')) return 'enum4linux'
  return n
}

/** How to obtain an env var (when unsure, invent nothing and just have the user fill it). */
const ENV_HINTS = {
  FOFA_KEY: 'lấy ở <https://fofa.info> đăng nhập → trung tâm cá nhân → API Key; tự kiểm tra `curl -s "https://fofa.info/api/v1/info/my?key=$FOFA_KEY"` trả về `"error":false` là hợp lệ',
  REDTEAM_VPS_HOST: 'điền địa chỉ đăng nhập VPS `user@host` (ví dụ `export REDTEAM_VPS_HOST=ubuntu@203.0.113.10`)',
  REDTEAM_VPS_USER: 'điền user đăng nhập VPS (mặc định `ubuntu`)',
  REDTEAM_VPS_KEY: 'điền đường dẫn private key VPS (mặc định `$DSH_HOME/redteam/toolkit/vps/id_rsa`, quyền bắt buộc `chmod 600`)',
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim() !== '')
  if (typeof v === 'string' && v.trim() !== '') return [v]
  return []
}

/**
 * Turn a `skill-availability.js` verdict into one repair suggestion.
 *
 * @param issue - `{ kind, skill, paths?, env?, placeholder? }`,
 *   `kind` ∈ `'file-missing' | 'content-missing' | 'env-missing' | 'path-missing' | 'placeholder' | 'shadowed'`.
 *   Extra fields beyond `checkSkill()`'s `problems` are accepted; field types are loose
 *   (string or array both fine).
 * @returns one suggestion (no newlines; commands all in backticks). When unsure it falls
 *   back to `SKILL_FIXES[skill]`, then to generic advice.
 */
export function fixesForIssue(issue) {
  const it = issue && typeof issue === 'object' ? issue : {}
  const kind = typeof it.kind === 'string' ? it.kind : ''
  const skill = typeof it.skill === 'string' ? it.skill : ''
  const skillName = skill === '' ? '<tên_skill>' : skill
  const skillHint = skill !== '' && Object.prototype.hasOwnProperty.call(SKILL_FIXES, skill) ? SKILL_FIXES[skill] : ''
  const parts = []

  if (kind === 'path-missing') {
    const tools = []
    const seen = new Set()
    for (const p of asArray(it.paths)) {
      const name = toolNameOfPath(p)
      if (name === null) continue
      const canon = canonicalTool(name)
      if (seen.has(canon)) continue          // list each tool once
      seen.add(canon)
      tools.push({ name, canon, path: p })
    }
    if (tools.length > 0) {
      const items = tools.map(({ name, canon, path }) => {
        const fix = Object.prototype.hasOwnProperty.call(TOOL_FIXES, canon) ? TOOL_FIXES[canon] : null
        if (fix === null) {
          return '`' + name + '` (' + path + '): máy này không có tool đó, chạy `' + SETUP + '` để bù;'
            + ' vẫn thiếu thì tự chuẩn bị binary đúng nền tảng đặt vào đường dẫn này và `chmod +x`.'
        }
        return '`' + name + '` (' + path + '): ' + fix.what + '. Cách sửa: ' + fix.install
      })
      parts.push('Thiếu ' + tools.length + ' tool, sửa lần lượt: ' + items.join('; '))
      parts.push('Không chắc thì chạy đồng loạt `' + SETUP + '` trước (idempotent: thiếu thì tải, hỏng thì xóa tải lại), rồi kiểm tra lại.')
    }
  } else if (kind === 'env-missing') {
    const names = asArray(it.env)
    if (names.length > 0) {
      const items = names.map((n) => {
        const hint = Object.prototype.hasOwnProperty.call(ENV_HINTS, n) ? ENV_HINTS[n] : 'giá trị do bạn tự cung cấp'
        return '`' + n + '`: `export ' + n + '=<giá_trị>` (' + hint + ')'
      })
      parts.push('Thiếu biến môi trường: ' + items.join('; ') + '.')
      parts.push('Để lâu dài: ghi vào `$DSH_HOME/.env` (mỗi dòng một `NAME=giá_trị`, nên `chmod 600`), sửa xong bắt buộc khởi động lại `dsh web` tiến trình hiện tại mới đọc được;'
        + ' hoặc để người dùng chạy `' + SETUP + '` (script sẽ hướng dẫn và kiểm tra ngay `FOFA_KEY` cùng các biến VPS).')
    }
  } else if (kind === 'placeholder') {
    const ph = typeof it.placeholder === 'string' && it.placeholder.trim() !== '' ? it.placeholder.trim() : 'địa chỉ hạ tầng bên ngoài'
    parts.push('`' + ph + '` trong nội dung skill vẫn là placeholder (nghĩa là môi trường này chưa cấu hình VPS).')
    parts.push('Cách điền: chạy `' + SETUP + '` để được hướng dẫn ghi `REDTEAM_VPS_HOST` (`user@host`) và `REDTEAM_VPS_KEY` (đường dẫn private key, mặc định `$DSH_HOME/redteam/toolkit/vps/id_rsa`);'
      + ' cũng có thể ghi thủ công `$DSH_HOME/.env` rồi khởi động lại `dsh web`, hoặc sửa trực tiếp `$DSH_HOME/skills/' + skillName + '.md` thay placeholder bằng địa chỉ thật (nhớ `chmod 600` cho private key).')
  } else if (kind === 'shadowed') {
    parts.push('Skill bị bản cùng tên che mất: `' + skillName + '` còn một bản cùng tên ở skill root khác (cấu hình đầy đủ hơn),'
      + ' nhưng theo thứ tự skill root hiện tại thì bản được nạp là bản thiếu, đứng trước.')
    parts.push('Cách sửa: đưa skill root đã cấu hình lên đầu thứ tự skill root (chỉnh thứ tự trong cài đặt plugin/thư mục skill), khởi động lại `dsh web` rồi kiểm tra lại;'
      + ' không cần bản còn lại thì xóa nó đi hoặc đổi tên, tránh bị che lần nữa.')
  } else if (kind === 'file-stale') {
    parts.push('Đường dẫn file mà skill ghi nhận không tồn tại trên máy này (nội dung skill vẫn nạp được, không ảnh hưởng gọi): loại đường dẫn này là đường dẫn tuyệt đối phân giải từ một máy trước đó, đổi máy là chắc chắn trỏ vào khoảng không.')
    parts.push('Cách sửa: khởi động lại `dsh web` một lần (lúc khởi động plugin sẽ đồng bộ skill đi kèm vào `$DSH_HOME/redteam/skills` trên máy này);'
      + ' nếu `DSH_HOME` trên máy này khác thư mục host thực dùng (đã đổi ổ / cài ở thư mục không mặc định), trỏ `DSH_HOME` vào đúng thư mục host dùng rồi khởi động lại.')
  } else if (kind === 'file-missing') {
    parts.push('File skill không tồn tại: cài lại plugin redteam (hoặc mount lại thư mục skill vào skill root) để ghi đè file skill, rồi khởi động lại `dsh web` và kiểm tra lại một lần.')
    parts.push('Nếu là skill tự đặt, xác nhận file nằm dưới skill root và tên file trùng tên skill (`<tên_skill>.md`).')
  } else if (kind === 'content-missing') {
    parts.push('Không đọc được nội dung skill (chỉ có metadata, không đánh giá được khả dụng): cài lại plugin redteam để ghi đè file skill;'
      + ' nếu là nguồn skill từ xa, xác nhận nguồn truy cập được rồi kéo lại, sau đó khởi động lại `dsh web`.')
    parts.push('Cần xác nhận tạm thời có dùng được không thì để agent dùng tool `skill` nạp thật một lần `' + skillName + '`.')
  }

  if (parts.length === 0) parts.push(skillHint !== '' ? skillHint : GENERIC_FIX)
  return parts.join(' ')
}
