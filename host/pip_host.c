/*
 * pip_host.c — MultiPiP Top 的 Edge Native Messaging host（Windows x64）
 *
 * Edge 以下列形式啟動本程式：
 *     pip_host.exe chrome-extension://<id>/ --parent-window=<十進位 HWND>
 * 目標視窗只由 --parent-window 決定；訊息正文只帶操作與目標狀態。
 *
 * 協定：stdin/stdout，每則訊息為 4 位元組原生位元組序長度 + UTF-8 JSON。
 * stdout 只輸出協定回應，除錯訊息一律寫到 stderr。
 *
 * 支援的請求：
 *     {"op":"setTopmost","enabled":true,"titleToken":"#k3f9a","id":1}
 *   - enabled     必填，true = HWND_TOPMOST，false = HWND_NOTOPMOST
 *   - titleToken  選填，視窗標題必須包含此字串才會動作（確認是對應小窗）
 *   - id          選填，整數，原樣回傳以便對應請求
 *
 * 編譯（Ubuntu / WSL）：
 *     x86_64-w64-mingw32-gcc -O2 -Wall -Wextra pip_host.c -o pip_host.exe -luser32
 */
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define HOST_VERSION "0.1.0"
#define MAX_MSG (64 * 1024)
#define TITLE_RETRY 15      /* 標題比對重試次數 */
#define TITLE_RETRY_MS 100  /* 每次間隔 */

static HWND g_root;                  /* 已驗證的頂層視窗 */
static const char *g_init_error;     /* 啟動時驗證失敗的錯誤碼 */
static char g_init_detail[256];

/* ---------------------------------------------------------------- 輸出 */

static void dbg(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    fputs("[pip_host] ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    fflush(stderr);
    va_end(ap);
}

static void send_raw(const char *json)
{
    uint32_t len = (uint32_t)strlen(json);
    fwrite(&len, sizeof len, 1, stdout);
    fwrite(json, 1, len, stdout);
    fflush(stdout);
}

/* 把 UTF-8 字串寫成 JSON 字串字面值（含引號） */
static void json_str(char *out, size_t cap, const char *s)
{
    size_t o = 0;
    if (cap < 3) { if (cap) out[0] = 0; return; }
    out[o++] = '"';
    for (; *s && o + 7 < cap; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = (char)c; }
        else if (c == '\n') { out[o++] = '\\'; out[o++] = 'n'; }
        else if (c == '\r') { out[o++] = '\\'; out[o++] = 'r'; }
        else if (c == '\t') { out[o++] = '\\'; out[o++] = 't'; }
        else if (c < 0x20) { o += (size_t)snprintf(out + o, cap - o, "\\u%04x", c); }
        else out[o++] = (char)c;
    }
    out[o++] = '"';
    out[o] = 0;
}

static void send_error(const char *op, long long id, int has_id,
                       const char *code, const char *message)
{
    char msg[1024], buf[2048], idbuf[32] = "";
    json_str(msg, sizeof msg, message ? message : "");
    if (has_id) snprintf(idbuf, sizeof idbuf, ",\"id\":%lld", id);
    snprintf(buf, sizeof buf,
             "{\"ok\":false,\"op\":\"%s\"%s,\"error\":\"%s\",\"message\":%s}",
             op ? op : "unknown", idbuf, code, msg);
    send_raw(buf);
}

/* ---------------------------------------------------------------- 輸入 */

static int read_exact(void *buf, size_t n)
{
    size_t got = 0;
    while (got < n) {
        size_t r = fread((char *)buf + got, 1, n - got, stdin);
        if (r == 0) return 0;
        got += r;
    }
    return 1;
}

/* 極簡 JSON 欄位查找：回傳 "key" 冒號後第一個非空白字元的位置，找不到回傳 NULL。
 * 只用於本協定的扁平物件，不處理巢狀結構。 */
static const char *json_find(const char *json, const char *key)
{
    size_t klen = strlen(key);
    const char *p = json;
    while ((p = strchr(p, '"')) != NULL) {
        p++;
        if (strncmp(p, key, klen) == 0 && p[klen] == '"') {
            const char *q = p + klen + 1;
            while (*q == ' ' || *q == '\t' || *q == '\r' || *q == '\n') q++;
            if (*q != ':') continue;
            q++;
            while (*q == ' ' || *q == '\t' || *q == '\r' || *q == '\n') q++;
            return q;
        }
        /* 跳過這個字串的其餘部分 */
        while (*p && *p != '"') { if (*p == '\\' && p[1]) p++; p++; }
        if (*p) p++;
    }
    return NULL;
}

static int hex4(const char *p, unsigned *out)
{
    unsigned v = 0;
    int i;
    for (i = 0; i < 4; i++) {
        char c = p[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else return 0;
    }
    *out = v;
    return 1;
}

static void put_utf8(char *out, size_t cap, size_t *o, unsigned cp)
{
    char b[4];
    int n, i;
    if (cp < 0x80) { b[0] = (char)cp; n = 1; }
    else if (cp < 0x800) { b[0] = (char)(0xC0 | (cp >> 6)); b[1] = (char)(0x80 | (cp & 0x3F)); n = 2; }
    else if (cp < 0x10000) {
        b[0] = (char)(0xE0 | (cp >> 12)); b[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        b[2] = (char)(0x80 | (cp & 0x3F)); n = 3;
    } else {
        b[0] = (char)(0xF0 | (cp >> 18)); b[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
        b[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); b[3] = (char)(0x80 | (cp & 0x3F)); n = 4;
    }
    if (*o + (size_t)n + 1 > cap) return;
    for (i = 0; i < n; i++) out[(*o)++] = b[i];
}

/* 讀取字串值並解開 JSON 跳脫（含 \uXXXX 與代理對），輸出 UTF-8。成功回傳 1。 */
static int json_get_str(const char *json, const char *key, char *out, size_t cap)
{
    const char *p = json_find(json, key);
    size_t o = 0;
    if (!p || *p != '"' || cap == 0) return 0;
    p++;
    while (*p && *p != '"') {
        unsigned cp;
        char c = *p++;
        if (c != '\\') { if (o + 1 < cap) out[o++] = c; continue; }
        c = *p ? *p++ : 0;
        switch (c) {
        case 'n': cp = '\n'; break;
        case 'r': cp = '\r'; break;
        case 't': cp = '\t'; break;
        case 'b': cp = '\b'; break;
        case 'f': cp = '\f'; break;
        case 'u':
            if (!hex4(p, &cp)) return 0;
            p += 4;
            if (cp >= 0xD800 && cp <= 0xDBFF && p[0] == '\\' && p[1] == 'u') {
                unsigned lo;
                if (hex4(p + 2, &lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    p += 6;
                }
            }
            break;
        case 0: return 0;
        default: cp = (unsigned char)c; break;  /* \" \\ \/ */
        }
        put_utf8(out, cap, &o, cp);
    }
    out[o] = 0;
    return *p == '"';
}

/* 讀取布林值：1 = true，0 = false，-1 = 缺少或型別錯誤 */
static int json_get_bool(const char *json, const char *key)
{
    const char *p = json_find(json, key);
    if (!p) return -1;
    if (strncmp(p, "true", 4) == 0) return 1;
    if (strncmp(p, "false", 5) == 0) return 0;
    return -1;
}

static int json_get_int(const char *json, const char *key, long long *out)
{
    const char *p = json_find(json, key);
    char *end;
    long long v;
    if (!p) return 0;
    v = strtoll(p, &end, 10);
    if (end == p) return 0;
    *out = v;
    return 1;
}

/* ---------------------------------------------------------------- 視窗 */

static void win_error_text(DWORD err, char *out, size_t cap)
{
    wchar_t w[256];
    DWORD n = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                             NULL, err, 0, w, 256, NULL);
    while (n && (w[n - 1] == L'\r' || w[n - 1] == L'\n' || w[n - 1] == L' ')) w[--n] = 0;
    if (!n || !WideCharToMultiByte(CP_UTF8, 0, w, -1, out, (int)cap, NULL, NULL))
        snprintf(out, cap, "Win32 error %lu", (unsigned long)err);
}

/* 驗證 HWND：必須是有效視窗，其頂層祖先為 Chromium 視窗類別，且屬於 msedge.exe。 */
static const char *validate_hwnd(HWND h, HWND *root_out, char *detail, size_t cap)
{
    HWND root;
    wchar_t cls[128];
    wchar_t image[MAX_PATH * 2];
    DWORD pid = 0, len = (DWORD)(sizeof image / sizeof image[0]);
    HANDLE proc;
    const wchar_t *base;

    if (!h) {
        snprintf(detail, cap, "Edge 提供的 --parent-window 為 0（請由小窗頁面呼叫 connectNative，而非 service worker）");
        return "parent_window_zero";
    }
    if (!IsWindow(h)) {
        snprintf(detail, cap, "--parent-window 不是有效的視窗代號");
        return "invalid_window";
    }
    root = GetAncestor(h, GA_ROOT);
    if (!root) root = h;

    if (!GetClassNameW(root, cls, 128) || wcsncmp(cls, L"Chrome_WidgetWin_", 17) != 0) {
        snprintf(detail, cap, "目標視窗不是 Edge 瀏覽器視窗");
        return "not_browser_window";
    }
    GetWindowThreadProcessId(root, &pid);
    proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!proc) {
        snprintf(detail, cap, "無法查詢視窗所屬程序 (pid %lu)", (unsigned long)pid);
        return "process_query_failed";
    }
    if (!QueryFullProcessImageNameW(proc, 0, image, &len)) {
        CloseHandle(proc);
        snprintf(detail, cap, "無法取得視窗所屬程序路徑");
        return "process_query_failed";
    }
    CloseHandle(proc);
    base = wcsrchr(image, L'\\');
    base = base ? base + 1 : image;
    if (_wcsicmp(base, L"msedge.exe") != 0) {
        snprintf(detail, cap, "目標視窗不屬於 msedge.exe");
        return "not_edge_window";
    }
    *root_out = root;
    return NULL;
}

/* 等待視窗標題出現 token（Edge 更新標題是非同步的） */
static int title_has_token(HWND h, const char *token_utf8, char *title_out, size_t cap)
{
    wchar_t token[128], title[512];
    int i;
    if (!MultiByteToWideChar(CP_UTF8, 0, token_utf8, -1, token, 128)) return 0;
    for (i = 0; i < TITLE_RETRY; i++) {
        title[0] = 0;
        GetWindowTextW(h, title, 512);
        if (wcsstr(title, token)) return 1;
        Sleep(TITLE_RETRY_MS);
    }
    if (!WideCharToMultiByte(CP_UTF8, 0, title, -1, title_out, (int)cap, NULL, NULL))
        title_out[0] = 0;
    return 0;
}

static void handle_set_topmost(const char *json, long long id, int has_id)
{
    char token[128], title[1024], detail[512], buf[1024], idbuf[32] = "";
    int enabled = json_get_bool(json, "enabled");
    LONG_PTR ex;
    int actual;

    if (enabled < 0) {
        send_error("setTopmost", id, has_id, "bad_request", "缺少布林欄位 enabled");
        return;
    }
    if (g_init_error) {
        send_error("setTopmost", id, has_id, g_init_error, g_init_detail);
        return;
    }
    if (!IsWindow(g_root)) {
        send_error("setTopmost", id, has_id, "window_gone", "目標小窗已關閉");
        return;
    }
    if (json_get_str(json, "titleToken", token, sizeof token) && token[0]) {
        if (!title_has_token(g_root, token, title, sizeof title)) {
            snprintf(detail, sizeof detail, "視窗標題不含識別碼，無法確認是對應的小窗（目前標題：%s）", title);
            send_error("setTopmost", id, has_id, "window_mismatch", detail);
            return;
        }
    }

    if (!SetWindowPos(g_root, enabled ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
                      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) {
        DWORD err = GetLastError();
        win_error_text(err, detail, sizeof detail);
        send_error("setTopmost", id, has_id, "setwindowpos_failed", detail);
        return;
    }
    ex = GetWindowLongPtrW(g_root, GWL_EXSTYLE);
    actual = (ex & WS_EX_TOPMOST) != 0;
    if (actual != enabled) {
        send_error("setTopmost", id, has_id, "state_mismatch",
                   "SetWindowPos 已呼叫，但視窗的置頂狀態沒有改變");
        return;
    }
    if (has_id) snprintf(idbuf, sizeof idbuf, ",\"id\":%lld", id);
    snprintf(buf, sizeof buf,
             "{\"ok\":true,\"op\":\"setTopmost\"%s,\"enabled\":%s,\"topmost\":%s,"
             "\"hwnd\":\"0x%llx\",\"version\":\"" HOST_VERSION "\"}",
             idbuf, enabled ? "true" : "false", actual ? "true" : "false",
             (unsigned long long)(uintptr_t)g_root);
    send_raw(buf);
    dbg("setTopmost(%d) hwnd=0x%llx ok", enabled, (unsigned long long)(uintptr_t)g_root);
}

/* ---------------------------------------------------------------- main */

int main(int argc, char **argv)
{
    unsigned long long parent = 0;
    int i, found = 0;
    static char msg[MAX_MSG + 1];

    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);

    for (i = 1; i < argc; i++) {
        const char *pre = "--parent-window=";
        if (strncmp(argv[i], pre, strlen(pre)) == 0) {
            parent = strtoull(argv[i] + strlen(pre), NULL, 10);
            found = 1;
        } else {
            dbg("arg: %s", argv[i]);
        }
    }
    if (!found) {
        g_init_error = "no_parent_window";
        snprintf(g_init_detail, sizeof g_init_detail, "啟動參數缺少 --parent-window");
    } else {
        g_init_error = validate_hwnd((HWND)(uintptr_t)parent, &g_root,
                                     g_init_detail, sizeof g_init_detail);
    }
    dbg("start v" HOST_VERSION " parent=%llu root=0x%llx init=%s", parent,
        (unsigned long long)(uintptr_t)g_root, g_init_error ? g_init_error : "ok");

    for (;;) {
        uint32_t len;
        char op[64];
        long long id = 0;
        int has_id;

        if (!read_exact(&len, sizeof len)) break;          /* EOF：Edge 關閉連線 */
        if (len > MAX_MSG) {
            send_error(NULL, 0, 0, "message_too_large", "訊息超過 64 KiB");
            return 1;
        }
        if (!read_exact(msg, len)) break;
        msg[len] = 0;

        has_id = json_get_int(msg, "id", &id);
        if (!json_get_str(msg, "op", op, sizeof op)) {
            send_error(NULL, id, has_id, "bad_request", "缺少字串欄位 op");
            continue;
        }
        if (strcmp(op, "setTopmost") == 0) {
            handle_set_topmost(msg, id, has_id);
        } else {
            send_error("unknown", id, has_id, "unknown_op", "不支援的操作");
        }
    }
    dbg("stdin closed, exit");
    return 0;
}
