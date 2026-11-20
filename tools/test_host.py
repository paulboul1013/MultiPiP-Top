"""pip_host.exe 協定測試（在 Windows 上執行）。

    python tools/test_host.py            # 只跑錯誤路徑，不動任何視窗
    python tools/test_host.py --edge     # 另外對一個現有 Edge 視窗切換置頂再還原

--edge 會找一個可見的 Edge 頂層視窗，設為置頂後立即取消（SWP_NOACTIVATE，不搶焦點）。
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import struct
import subprocess
import sys

HOST = os.path.join(os.path.dirname(__file__), "..", "host", "pip_host.exe")
ORIGIN = "chrome-extension://test/"
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32


def run(parent, messages):
    args = [HOST, ORIGIN] + ([f"--parent-window={parent}"] if parent is not None else [])
    p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    data = b""
    for m in messages:
        raw = m if isinstance(m, bytes) else json.dumps(m).encode()
        data += struct.pack("<I", len(raw)) + raw
    out, err = p.communicate(data, timeout=10)
    replies = []
    while out:
        (n,) = struct.unpack("<I", out[:4])
        replies.append(json.loads(out[4:4 + n].decode("utf-8")))
        out = out[4 + n:]
    return p.returncode, replies, err.decode("utf-8", "replace")


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -> {detail}" if not cond else ""))
    return cond


def find_edge_window():
    found = []
    psapi_query = kernel32.QueryFullProcessImageNameW

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd) or (user32.GetWindowLongW(hwnd, -20) & 0x8):
            return True  # 跳過不可見或原本就置頂的視窗，避免改到使用者的設定
        cls = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, cls, 128)
        if not cls.value.startswith("Chrome_WidgetWin_"):
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        h = kernel32.OpenProcess(0x1000, False, pid.value)
        if not h:
            return True
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        psapi_query(h, 0, buf, ctypes.byref(size))
        kernel32.CloseHandle(h)
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, 512)
        if buf.value.lower().endswith("\\msedge.exe") and title.value:
            found.append((hwnd, title.value))
        return True

    user32.EnumWindows(cb, 0)
    return found[0] if found else None


def main():
    ok = True
    st = {"op": "setTopmost", "enabled": True, "id": 7}

    rc, r, _ = run(0, [st])
    ok &= check("HWND 0 -> parent_window_zero", r and r[0]["error"] == "parent_window_zero" and r[0]["id"] == 7, r)
    rc, r, _ = run(None, [st])
    ok &= check("缺少 --parent-window -> no_parent_window", r and r[0]["error"] == "no_parent_window", r)
    rc, r, _ = run(0x7FFFFFF0, [st])
    ok &= check("無效 HWND -> invalid_window", r and r[0]["error"] == "invalid_window", r)
    desktop = user32.GetShellWindow()
    rc, r, _ = run(desktop, [st])
    ok &= check("非 Edge 視窗 -> not_browser_window", r and r[0]["error"] == "not_browser_window", r)
    rc, r, _ = run(0, [{"op": "nope"}, {"x": 1}, {"op": "setTopmost"}])
    ok &= check("未知 op / 缺 op / 缺 enabled",
                [x["error"] for x in r] == ["unknown_op", "bad_request", "bad_request"], r)
    rc, r, _ = run(0, [])
    ok &= check("stdin EOF 正常結束", rc == 0 and r == [], rc)

    if "--edge" in sys.argv:
        w = find_edge_window()
        if not w:
            print("SKIP 找不到可見的 Edge 視窗")
        else:
            hwnd, title = w
            token = title[:6]
            rc, r, err = run(hwnd, [
                {"op": "setTopmost", "enabled": True, "titleToken": token, "id": 1},
                {"op": "setTopmost", "enabled": False, "titleToken": token, "id": 2},
                {"op": "setTopmost", "enabled": True, "titleToken": "#no-such-token", "id": 3},
            ])
            ok &= check("Edge 視窗置頂 on", r[0].get("ok") and r[0]["topmost"] is True, r[0])
            ok &= check("Edge 視窗置頂 off", r[1].get("ok") and r[1]["topmost"] is False, r[1])
            ok &= check("標題 token 不符 -> window_mismatch", r[2].get("error") == "window_mismatch", r[2])
            ex = user32.GetWindowLongW(hwnd, -20)
            ok &= check("測試後視窗已恢復非置頂", not (ex & 0x8), hex(ex))
            print("stderr:", err.strip().replace("\n", " | "))

    print("ALL PASS" if ok else "SOME FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
