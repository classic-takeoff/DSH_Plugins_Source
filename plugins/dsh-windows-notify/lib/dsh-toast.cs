// Windows toast activation bridge for DeepSeek Harness.
//
// This helper is deliberately small and dependency-free:
//   * --register   creates the per-user AUMID, COM LocalServer32 registration and
//                  the Start-menu shortcut carrying the AUMID + ToastActivatorCLSID;
//   * -Embedding   runs as the COM local server and receives toast activations;
//   * --activate   injects an activation for local testing;
//   * --status     prints what is currently registered.
//
// The helper never sees the model summary or session title: the notification text
// lives only in the toast XML created by show-toast.ps1. Toast arguments carry a
// random opaque token, never a session id or reply text.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: ComVisible(false)]
[assembly: Guid("7d3c2a64-9f1b-4e58-9c7a-3b5e1d2f8a60")]

[ComImport]
[ComVisible(true)]
[Guid("53e31837-6600-4a81-9395-75cffe746f94")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface INotificationActivationCallback
{
    [PreserveSig]
    int Activate(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string invokedArgs,
        IntPtr data,
        uint count);
}

[StructLayout(LayoutKind.Sequential)]
internal struct NotificationUserInputData
{
    public IntPtr Key;
    public IntPtr Value;
}

/// <summary>
/// The COM local server object Windows creates when a toast is activated. It is
/// public and ComVisible so the CLR can hand a stable CCW to COM.
/// </summary>
[ComVisible(true)]
[Guid("7d3c2a64-9f1b-4e58-9c7a-3b5e1d2f8a60")]
[ClassInterface(ClassInterfaceType.None)]
public sealed class NotificationActivator : INotificationActivationCallback
{
    public int Activate(string appUserModelId, string invokedArgs, IntPtr data, uint count)
    {
        try
        {
            string text = Program.ReadReplyInput(data, count);
            Program.HandleActivation(invokedArgs, text, true);
        }
        catch (Exception error)
        {
            Program.Log("activation failed: " + error);
        }
        finally
        {
            Program.CompleteActivation();
        }
        return 0;
    }
}

[ComImport]
[Guid("00000001-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IClassFactoryNative
{
    [PreserveSig]
    int CreateInstance(
        [MarshalAs(UnmanagedType.IUnknown)] object outer,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.IUnknown)] out object instance);

    [PreserveSig]
    int LockServer([MarshalAs(UnmanagedType.Bool)] bool lockServer);
}

/// <summary>
/// The class factory DCOM asks for after launching this LocalServer32. Keeping
/// this explicit (instead of RegistrationServices) lets the activation be
/// traced in activator.log when DCOM fails.
/// </summary>
[ComVisible(true)]
public sealed class NotificationClassFactory : IClassFactoryNative
{
    private static readonly Guid IidUnknown = new Guid("00000000-0000-0000-c000-000000000046");
    private static readonly Guid IidCallback = new Guid("53e31837-6600-4a81-9395-75cffe746f94");

    public int CreateInstance(object outer, ref Guid interfaceId, out object instance)
    {
        Program.Log("CreateInstance riid=" + interfaceId.ToString("D") + " outer=" + (outer != null));
        instance = null;
        if (outer != null) return unchecked((int)0x80040110);
        if (interfaceId != IidUnknown && interfaceId != IidCallback) return unchecked((int)0x80004002);
        instance = new NotificationActivator();
        return 0;
    }

    public int LockServer(bool lockServer)
    {
        Program.Log("LockServer " + lockServer);
        return 0;
    }
}

internal static class Program
{
    internal const string Clsid = "7d3c2a64-9f1b-4e58-9c7a-3b5e1d2f8a60";
    internal const string AppUserModelId = "com.deepseek.dsh.notify";
    internal const string DisplayName = "DeepSeek Harness";
    internal const string ShortcutRelativePath = @"Microsoft\Windows\Start Menu\Programs\DeepSeek Harness\Notifications.lnk";

    private static int _activated;
    private static int _comInitialized;
    private static NotificationClassFactory _classFactory;

    private static string DataDirectory
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DeepSeekHarness",
                "desktop-notify");
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            Log("main start: " + (args.Length > 0 ? args[0] : ""));
            if (args.Length == 0)
            {
                Console.WriteLine("dsh-toast.exe --register <aumid> <iconPath> <appPath> <shortcutPath>");
                Console.WriteLine("dsh-toast.exe --unregister");
                Console.WriteLine("dsh-toast.exe --status");
                Console.WriteLine("dsh-toast.exe --activate <open:token|reply:token> [--reply text] [--no-focus]");
                return 2;
            }

            EnsureComInitialized();

            string command = args[0].ToLowerInvariant();
            if (command == "-embedding" || command == "/embedding" || command == "-toastnotification")
            {
                // A console-subsystem process started by COM must not show a
                // console window; the Host's own --register spawn uses
                // windowsHide instead, so a normal CLI keeps its console.
                IntPtr console = GetConsoleWindow();
                if (console != IntPtr.Zero) ShowWindow(console, 0);
            }

            switch (command)
            {
                case "--register":
                    return Register(args);
                case "--unregister":
                    return Unregister();
                case "--status":
                    return Status();
                case "--activate":
                    return ActivateFromCommandLine(args);
                case "-embedding":
                case "/embedding":
                case "-toastnotification":
                    return RunComServer();
                default:
                    // COM activation may pass an unexpected switch; prefer serving
                    // over exiting when we were clearly started with an argument.
                    Log("unknown command line: " + string.Join(" ", args));
                    return 2;
            }
        }
        catch (Exception error)
        {
            Log("fatal: " + error);
            try { Console.Error.WriteLine(error.Message); } catch { /* no console */ }
            return 1;
        }
        finally
        {
            if (Interlocked.Exchange(ref _comInitialized, 0) != 0) CoUninitialize();
        }
    }

    private static void EnsureComInitialized()
    {
        int hr = CoInitializeEx(IntPtr.Zero, 0x2);
        Log("CoInitializeEx=0x" + hr.ToString("x8"));
        if (hr >= 0)
        {
            Interlocked.Exchange(ref _comInitialized, 1);
            return;
        }
        // RPC_E_CHANGED_MODE means another apartment already initialized COM;
        // staying in that apartment is fine for our short-lived helper.
        if (hr != unchecked((int)0x80010106)) Marshal.ThrowExceptionForHR(hr);
    }

    private static int Register(string[] args)
    {
        if (args.Length < 5)
        {
            WriteJson("{\"ok\":false,\"error\":\"usage: --register <aumid> <iconPath> <appPath> <shortcutPath>\"}");
            return 2;
        }

        string aumid = args[1];
        string iconPath = args[2];
        string appPath = args[3];
        string shortcutPath = args[4];

        if (string.IsNullOrWhiteSpace(aumid) || aumid.Length > 128)
        {
            WriteJson("{\"ok\":false,\"error\":\"invalid aumid\"}");
            return 2;
        }
        if (!File.Exists(appPath))
        {
            WriteJson("{\"ok\":false,\"error\":\"app executable not found\"}");
            return 2;
        }
        if (!File.Exists(iconPath))
        {
            WriteJson("{\"ok\":false,\"error\":\"icon not found\"}");
            return 2;
        }

        string exePath = Process.GetCurrentProcess().MainModule.FileName;
        string iconUri = new Uri(iconPath).AbsoluteUri;

        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\AppUserModelId\" + aumid))
        {
            if (key == null) throw new InvalidOperationException("cannot create AppUserModelId key");
            key.SetValue("DisplayName", DisplayName, RegistryValueKind.String);
            key.SetValue("IconUri", iconUri, RegistryValueKind.String);
            key.SetValue("CustomActivator", "{" + Clsid + "}", RegistryValueKind.String);
            key.SetValue("ShowInSettings", 1, RegistryValueKind.DWord);
        }

        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\CLSID\{" + Clsid + "}"))
        {
            if (key == null) throw new InvalidOperationException("cannot create CLSID key");
            key.SetValue(null, "DeepSeek Harness Windows Toast Activator", RegistryValueKind.String);
            key.SetValue("AppID", "{" + Clsid + "}", RegistryValueKind.String);
            using (RegistryKey server = key.CreateSubKey("LocalServer32"))
            {
                if (server == null) throw new InvalidOperationException("cannot create LocalServer32 key");
                server.SetValue(null, "\"" + exePath + "\"", RegistryValueKind.String);
            }
        }

        using (RegistryKey appId = Registry.CurrentUser.CreateSubKey(@"Software\Classes\AppID\{" + Clsid + "}"))
        {
            if (appId == null) throw new InvalidOperationException("cannot create AppID key");
            appId.SetValue(null, "DeepSeek Harness Toast Activator", RegistryValueKind.String);
            appId.SetValue("RunAs", "Interactive User", RegistryValueKind.String);
        }

        CreateShortcut(shortcutPath, appPath, aumid, new Guid(Clsid));

        WriteJson("{\"ok\":true,\"clsid\":\"" + Clsid + "\",\"shortcut\":\"" + JsonEscape(shortcutPath) + "\"}");
        return 0;
    }

    private static int Unregister()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Classes\AppUserModelId\" + AppUserModelId, true))
            {
                if (key != null) key.DeleteValue("CustomActivator", false);
            }
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\CLSID\{" + Clsid + "}", false);
        }
        catch (Exception error)
        {
            Log("unregister registry failed: " + error.Message);
        }

        string shortcut = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        shortcut = Path.Combine(shortcut, ShortcutRelativePath);
        try
        {
            if (File.Exists(shortcut)) File.Delete(shortcut);
        }
        catch (Exception error)
        {
            Log("unregister shortcut failed: " + error.Message);
        }

        WriteJson("{\"ok\":true}");
        return 0;
    }

    private static int Status()
    {
        string shortcut = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            ShortcutRelativePath);

        bool aumid = false;
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Classes\AppUserModelId\" + AppUserModelId))
        {
            aumid = key != null && key.GetValue("DisplayName") != null;
        }
        bool clsid = false;
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Classes\CLSID\{" + Clsid + @"}\LocalServer32"))
        {
            clsid = key != null && key.GetValue(null) != null;
        }

        WriteJson("{\"ok\":true,\"aumid\":" + Bool(aumid) + ",\"clsid\":" + Bool(clsid) +
                  ",\"shortcut\":" + Bool(File.Exists(shortcut)) + ",\"shortcutPath\":\"" +
                  JsonEscape(shortcut) + "\"}");
        return 0;
    }

    private static int ActivateFromCommandLine(string[] args)
    {
        bool focus = true;
        string invokedArgs = null;
        string reply = null;
        for (int index = 1; index < args.Length; index++)
        {
            string value = args[index];
            if (value == "--no-focus") focus = false;
            else if (value == "--reply" && index + 1 < args.Length) reply = args[++index];
            else if (invokedArgs == null) invokedArgs = value;
        }
        if (invokedArgs == null)
        {
            Console.Error.WriteLine("missing activation arguments");
            return 2;
        }
        return HandleActivation(invokedArgs, reply, focus);
    }

    internal static int HandleActivation(string invokedArgs, string text, bool focus)
    {        BridgeInfo bridge = BridgeInfo.Read();
        string action = null;
        string token = null;

        if (!string.IsNullOrWhiteSpace(invokedArgs))
        {
            int separator = invokedArgs.IndexOf(':');
            if (separator > 0 && separator < invokedArgs.Length - 1)
            {
                action = invokedArgs.Substring(0, separator);
                token = invokedArgs.Substring(separator + 1);
            }
        }

        if (action == null)
        {
            // A body click with no arguments: only bring the app forward.
            FocusApp(bridge == null ? null : bridge.AppPath);
            return 0;
        }

        if (!IsValidToken(token))
        {
            Log("activation rejected: malformed token");
            return 1;
        }

        if (action == "reply")
        {
            text = (text ?? string.Empty).Trim();
            if (text.Length == 0)
            {
                Log("activation ignored: empty reply");
                return 0;
            }
            if (text.Length > 4000) text = text.Substring(0, 4000);
        }
        else if (action != "open")
        {
            Log("activation rejected: unknown action " + action);
            return 1;
        }

        string nonce = Guid.NewGuid().ToString("N");
        bool posted = bridge != null && TryPost(bridge, token, action, text, nonce);
        if (!posted) Spool(token, action, text, nonce);

        if (action == "open" || (action == "reply" && !posted) || focus)
        {
            FocusApp(bridge == null ? null : bridge.AppPath);
        }

        Log("activation action=" + action + " token=" + TokenPrefix(token) +
            " posted=" + posted + (action == "reply" ? " textLength=" + text.Length : string.Empty));
        return 0;
    }

    /// <summary>
    /// Loopback endpoint and launching facts written by the Host plugin. The file
    /// is user-private (LOCALAPPDATA) and carries a per-process random secret.
    /// </summary>
    private sealed class BridgeInfo
    {
        public int Port;
        public string Secret;
        public string AppPath;

        public static BridgeInfo Read()
        {
            try
            {
                string path = Path.Combine(DataDirectory, "bridge.ini");
                if (!File.Exists(path)) return null;
                Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (string line in File.ReadAllLines(path, Encoding.UTF8))
                {
                    if (line.Length == 0 || line[0] == '#') continue;
                    int separator = line.IndexOf('=');
                    if (separator <= 0) continue;
                    values[line.Substring(0, separator)] = line.Substring(separator + 1);
                }

                int port;
                string portText;
                if (!values.TryGetValue("port", out portText) || !int.TryParse(portText, out port) ||
                    port < 1 || port > 65535) return null;
                string secret;
                if (!values.TryGetValue("secret", out secret) || string.IsNullOrEmpty(secret)) return null;

                string appPath;
                values.TryGetValue("app", out appPath);
                return new BridgeInfo { Port = port, Secret = secret, AppPath = appPath };
            }
            catch
            {
                return null;
            }
        }
    }

    private static bool TryPost(BridgeInfo bridge, string token, string action, string text, string nonce)
    {
        try
        {
            string body = "token=" + Uri.EscapeDataString(token) +
                          "&action=" + Uri.EscapeDataString(action) +
                          "&nonce=" + Uri.EscapeDataString(nonce) +
                          "&text=" + Uri.EscapeDataString(text ?? string.Empty);
            byte[] bytes = Encoding.UTF8.GetBytes(body);

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                "http://127.0.0.1:" + bridge.Port.ToString() + "/activate");
            request.Method = "POST";
            request.ContentType = "application/x-www-form-urlencoded; charset=utf-8";
            request.Proxy = null;
            request.Timeout = 6000;
            request.ReadWriteTimeout = 6000;
            request.Headers["X-DSH-Notify-Secret"] = bridge.Secret;
            request.ContentLength = bytes.Length;

            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(bytes, 0, bytes.Length);
            }

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                int code = (int)response.StatusCode;
                return code >= 200 && code < 300;
            }
        }
        catch (WebException error)
        {
            HttpWebResponse response = error.Response as HttpWebResponse;
            if (response != null)
            {
                int code = (int)response.StatusCode;
                response.Dispose();
                // 409 means the host already handled this activation; it is a
                // successful, idempotent outcome, not a transport failure.
                if (code == 409) return true;
                Log("bridge post HTTP " + code);
            }
            else
            {
                Log("bridge post unavailable: " + error.Status);
            }
            return false;
        }
        catch (Exception error)
        {
            Log("bridge post failed: " + error.Message);
            return false;
        }
    }

    private static void Spool(string token, string action, string text, string nonce)
    {
        try
        {
            string directory = Path.Combine(DataDirectory, "pending");
            Directory.CreateDirectory(directory);
            string name = DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") + "-" +
                          Guid.NewGuid().ToString("N") + ".pending";
            string path = Path.Combine(directory, name);
            StringBuilder content = new StringBuilder();
            content.Append("token=").Append(token).Append('\n');
            content.Append("action=").Append(action).Append('\n');
            content.Append("nonce=").Append(nonce).Append('\n');
            content.Append("text=").Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(text ?? string.Empty))).Append('\n');
            content.Append("created=").Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).Append('\n');
            File.WriteAllText(path, content.ToString(), new UTF8Encoding(false));
            Log("activation spooled for a cold host");
        }
        catch (Exception error)
        {
            Log("spool failed: " + error.Message);
        }
    }

    private static void FocusApp(string appPath)
    {
        try
        {
            Process.Start(new ProcessStartInfo("dsh://open") { UseShellExecute = true });
            return;
        }
        catch (Exception error)
        {
            Log("focus via dsh:// failed: " + error.Message);
        }

        if (!string.IsNullOrWhiteSpace(appPath) && File.Exists(appPath))
        {
            try
            {
                Process.Start(new ProcessStartInfo(appPath) { UseShellExecute = true });
            }
            catch (Exception error)
            {
                Log("focus via executable failed: " + error.Message);
            }
        }
    }

    private static int RunComServer()
    {
        Log("COM server begin");
        int security = CoInitializeSecurity(
            IntPtr.Zero,
            -1,
            IntPtr.Zero,
            IntPtr.Zero,
            0, /* RPC_C_AUTHN_LEVEL_DEFAULT */
            3, /* RPC_C_IMP_LEVEL_IMPERSONATE */
            IntPtr.Zero,
            0, /* EOAC_NONE */
            IntPtr.Zero);
        Log("CoInitializeSecurity=0x" + security.ToString("x8"));

        Guid clsid = new Guid(Clsid);
        _classFactory = new NotificationClassFactory();
        uint cookie;
        int hr = CoRegisterClassObject(
            ref clsid,
            _classFactory,
            4u, /* CLSCTX_LOCAL_SERVER */
            1u, /* REGCLS_MULTIPLEUSE */
            out cookie);
        Log("CoRegisterClassObject=0x" + hr.ToString("x8") + " cookie=" + cookie);
        if (hr < 0) return 5;

        // A COM activation that never arrives must not leave a permanent process.
        using (System.Threading.Timer watchdog = new System.Threading.Timer(delegate
        {
            if (Volatile.Read(ref _activated) == 0)
            {
                Log("COM activation timed out");
                Environment.Exit(0);
            }
        }, null, 30000, Timeout.Infinite))
        {
            // ApplicationContext supplies the Windows message pump and OLE
            // message filter that COM local-server activation expects.
            Application.Run(new ApplicationContext());
        }

        CoRevokeClassObject(cookie);
        Log("COM server stopped");
        return 0;
    }

    internal static void CompleteActivation()
    {
        if (Interlocked.Exchange(ref _activated, 1) == 0)
        {
            try { Application.ExitThread(); }
            catch { PostQuitMessage(0); }
        }
    }

    internal static string ReadReplyInput(IntPtr data, uint count)
    {
        if (data == IntPtr.Zero || count == 0) return string.Empty;
        int size = Marshal.SizeOf(typeof(NotificationUserInputData));
        for (uint index = 0; index < count; index++)
        {
            IntPtr item = new IntPtr(data.ToInt64() + (long)index * size);
            NotificationUserInputData entry =
                (NotificationUserInputData)Marshal.PtrToStructure(item, typeof(NotificationUserInputData));
            string key = Marshal.PtrToStringUni(entry.Key);
            if (string.Equals(key, "reply", StringComparison.OrdinalIgnoreCase))
            {
                return Marshal.PtrToStringUni(entry.Value) ?? string.Empty;
            }
        }
        return string.Empty;
    }

    private static bool IsValidToken(string token)
    {
        if (string.IsNullOrEmpty(token) || token.Length < 16 || token.Length > 128) return false;
        for (int index = 0; index < token.Length; index++)
        {
            char value = token[index];
            bool valid = (value >= 'a' && value <= 'z') ||
                         (value >= 'A' && value <= 'Z') ||
                         (value >= '0' && value <= '9') ||
                         value == '_' || value == '-';
            if (!valid) return false;
        }
        return true;
    }

    private static string TokenPrefix(string token)
    {
        return token.Length <= 6 ? token : token.Substring(0, 6);
    }

    private static string JsonEscape(string value)
    {
        if (value == null) return string.Empty;
        StringBuilder builder = new StringBuilder(value.Length + 8);
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': builder.Append("\\\\"); break;
                case '"': builder.Append("\\\""); break;
                case '\r': builder.Append("\\r"); break;
                case '\n': builder.Append("\\n"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (character < 0x20) builder.Append("\\u").Append(((int)character).ToString("x4"));
                    else builder.Append(character);
                    break;
            }
        }
        return builder.ToString();
    }

    private static string Bool(bool value)
    {
        return value ? "true" : "false";
    }

    private static void WriteJson(string value)
    {
        Console.WriteLine(value);
    }

    internal static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(DataDirectory);
            string path = Path.Combine(DataDirectory, "activator.log");
            FileInfo info = new FileInfo(path);
            if (info.Exists && info.Length > 128 * 1024)
            {
                string previous = path + ".1";
                try
                {
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(path, previous);
                }
                catch
                {
                    // Rotating is best-effort; keep appending if it fails.
                }
            }
            File.AppendAllText(
                path,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + message + "\r\n",
                new UTF8Encoding(false));
        }
        catch
        {
            // Logging must never break activation.
        }
    }

    private static void CreateShortcut(string shortcutPath, string appPath, string aumid, Guid activatorClsid)
    {
        string directory = Path.GetDirectoryName(shortcutPath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        Type shellLinkType = Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"), true);
        object instance = Activator.CreateInstance(shellLinkType);
        try
        {
            IShellLinkW link = (IShellLinkW)instance;
            link.SetPath(appPath);
            link.SetArguments("dsh://open");
            link.SetWorkingDirectory(Path.GetDirectoryName(appPath));
            link.SetIconLocation(appPath, 0);
            link.SetDescription("DeepSeek Harness notifications");

            IPropertyStore store = (IPropertyStore)instance;
            PropertyKey idKey = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
            PropVariant idValue = new PropVariant();
            idValue.vt = 31; // VT_LPWSTR
            idValue.pointer = Marshal.StringToCoTaskMemUni(aumid);
            try
            {
                store.SetValue(ref idKey, ref idValue);
            }
            finally
            {
                PropVariantClear(ref idValue);
            }

            PropertyKey clsidKey = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 26);
            PropVariant clsidValue = new PropVariant();
            clsidValue.vt = 72; // VT_CLSID
            clsidValue.pointer = Marshal.AllocCoTaskMem(16);
            Marshal.StructureToPtr(activatorClsid, clsidValue.pointer, false);
            try
            {
                store.SetValue(ref clsidKey, ref clsidValue);
            }
            finally
            {
                PropVariantClear(ref clsidValue);
            }

            store.Commit();
            ((IPersistFile)instance).Save(shortcutPath, true);
        }
        finally
        {
            if (Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance);
        }
    }

    // ---- Win32 / COM interop ------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid formatId;
        public uint propertyId;

        public PropertyKey(Guid formatId, uint propertyId)
        {
            this.formatId = formatId;
            this.propertyId = propertyId;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant
    {
        public ushort vt;
        public ushort reserved1;
        public ushort reserved2;
        public ushort reserved3;
        public IntPtr pointer;
        public int pointer2;
    }

    [ComImport]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int fileSize, IntPtr findData, uint flags);
        void GetIDList(out IntPtr itemIdList);
        void SetIDList(IntPtr itemIdList);
        void GetDescription([MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int nameSize);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int directorySize);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int argumentsSize);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCommand);
        void SetShowCmd(int showCommand);
        void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int iconPathSize, out int iconIndex);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string relativePath, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, uint apartmentType);

    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();

    [DllImport("ole32.dll")]
    private static extern int CoInitializeSecurity(
        IntPtr securityDescriptor,
        int authenticationServiceCount,
        IntPtr authenticationServices,
        IntPtr reserved,
        uint authenticationLevel,
        uint impersonationLevel,
        IntPtr authenticationList,
        uint capabilities,
        IntPtr reserved3);

    [DllImport("ole32.dll")]
    private static extern int CoRegisterClassObject(
        ref Guid classId,
        [MarshalAs(UnmanagedType.Interface)] IClassFactoryNative factory,
        uint context,
        uint flags,
        out uint cookie);

    [DllImport("ole32.dll")]
    private static extern int CoRevokeClassObject(uint cookie);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG message, IntPtr window, uint filterMin, uint filterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG message);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int exitCode);
}
