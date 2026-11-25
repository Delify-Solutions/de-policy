#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";

const args = process.argv.slice(2);

function printStatus(state) {
  const out = [];
  out.push("de-policy Trạng thái / Status");
  out.push("  Bề mặt / surface  " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  Cài desktop       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  Gốc plugin        " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  Gốc plugin        " + core.missingAiBaseMessage());
  }
  out.push(`  Thư mục shim      ${state.shim_dir || "chưa xác định / not found"}`);
  out.push(`  Sao lưu / backup  ${state.has_backup ? "có / yes" : "không / no"}`);
  out.push(`  Tệp inject        ${state.override_path}`);
  out.push(`  Trạng thái        ${state.override_status}`);
  out.push("");
  out.push(`  Bản vá ${state.patches_applied}/${core.ALL_PATCHES.length} đã sạch, ${state.patches_pending} chờ`);
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--uninstall", "--status", "--edit", "--help"].includes(a));

  if (mode === "--help" || args.includes("-h")) {
    console.log(`de-policy cách dùng:
  de-policy --status     xem trạng thái
  de-policy --apply      áp dụng toàn bộ thanh lọc (prompt + code + shim + override)
  de-policy --revert     hoàn nguyên
  de-policy --uninstall  gỡ plugin (đã áp dụng thì hoàn nguyên trước)
  de-policy --edit       sửa tệp inject prompt-inject.md
  de-policy --help       trợ giúp`);
    return;
  }

  const state = await core.gatherState();
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: trỏ DSH_BASE vào thư mục @deepseek-ai chứa dsh-agent-instructions/lib");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] Cả prompt lẫn bộ luật đều rỗng, phải thêm prompt trước");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  Host / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ đã sạch" : r.status === "already" ? "- đã mới nhất"
        : r.status === "missing_file" ? "⚠ thiếu tệp" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  nhiều host / multi-host: ${hosts.length} bản @deepseek-ai đã thanh lọc`);
    }
    console.log(inject.source === "rule"
      ? "  - dùng bộ luật hiện tại, không ghi lại tệp prompt"
      : "  - dùng tệp prompt đã có");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} đã inject / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} đã inject từ trước`);
        else if (st === "missing") console.log(`  - shim ${fname} không tồn tại / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ Không xác định được thư mục shim, bỏ qua bước inject");
    }
    console.log("");
    console.log("Xong toàn bộ / All done. Khởi động lại dsh để áp dụng.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ đã hoàn nguyên / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ hoàn nguyên thất bại ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - không có bản sao lưu nào để hoàn nguyên");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("Hoàn nguyên xong / Revert done. Khởi động lại dsh để phục hồi.");
    console.log("Lưu ý: prompt-inject.md được giữ lại (tệp của người dùng).");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  Đã phát hiện bản vá, hoàn nguyên về bản gốc.");
    else console.log("  Không thấy bản vá nào được áp dụng, vẫn sẽ xoá tệp plugin.");
    if (result.override?.removed) console.log(`  Đã xoá ${result.override.path}`);
    if (result.stripped?.length) console.log(`  Đã gỡ khỏi profile: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  Dừng gỡ: hoàn nguyên thất bại, chưa xoá tệp plugin.");
      process.exit(1);
    }
    console.log("");
    console.log("Gỡ xong. Hãy khởi động lại dsh.");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ Đã tạo tệp inject mặc định: ${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → Đã mở ${r.editor} để sửa tệp inject: ${r.path}`);
    }
    console.log("  Sửa xong thì khởi động lại dsh để áp dụng.");
  } else {
    console.log("Mặc định không thanh lọc, dùng --apply để áp dụng.");
  }
}

main().catch((e) => {
  console.error("[de-policy] error:", e);
  process.exit(1);
});
