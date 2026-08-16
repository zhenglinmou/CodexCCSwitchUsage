using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Codex CCSwitch Usage")]
[assembly: AssemblyDescription("Launch Codex with the CCSwitch usage extension")]
[assembly: AssemblyCompany("Local")]
[assembly: AssemblyProduct("Codex CCSwitch Usage")]

internal static class Program
{
    private const string MutexName = @"Local\CodexCCSwitchUsageLauncher";
    private const string WindowTitle = "Codex CCSwitch Usage";
    private const uint DETACHED_PROCESS = 0x00000008;

    [STAThread]
    private static int Main(string[] args)
    {
        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        if (args.Length == 1 && string.Equals(args[0], "--verify", StringComparison.OrdinalIgnoreCase))
        {
            return VerifyPackage(root);
        }
        if (args.Length > 0 && string.Equals(args[0], "--start-host", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                int verification = VerifyPackage(root);
                if (verification != 0) throw new InvalidDataException("Package integrity verification failed with code " + verification + ".");
                return StartDetachedHost(root, args);
            }
            catch (Exception error)
            {
                WriteFailureLog(root, error.ToString());
                return 1;
            }
        }

        bool createdNew;
        using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
        {
            if (!createdNew) return 0;
            try
            {
                return Launch(root);
            }
            catch (Exception error)
            {
                ReportFailure(root, error.ToString());
                return 1;
            }
            finally
            {
                try { mutex.ReleaseMutex(); } catch { }
            }
        }
    }

    private static int Launch(string root)
    {
        int verification = VerifyPackage(root);
        if (verification != 0) throw new InvalidDataException("Package integrity verification failed with code " + verification + ".");
        string script = Path.Combine(root, "scripts", "launch.ps1");
        string nodeDirectory = Path.Combine(root, "runtime-bin");
        string node = Path.Combine(nodeDirectory, "node.exe");
        string powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe"
        );

        RequireFile(script, "launch.ps1");
        RequireFile(node, "bundled node.exe");
        RequireFile(powershell, "Windows PowerShell");
        Directory.CreateDirectory(Path.Combine(root, "runtime"));

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = powershell;
        startInfo.Arguments = BuildArguments(new string[] {
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden",
            "-File", script,
            "-InstallRoot", root,
            "-AllowCodexRestart"
        });
        startInfo.WorkingDirectory = root;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.WindowStyle = ProcessWindowStyle.Hidden;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        startInfo.StandardOutputEncoding = Encoding.UTF8;
        startInfo.StandardErrorEncoding = Encoding.UTF8;

        StringBuilder output = new StringBuilder();
        StringBuilder errors = new StringBuilder();
        object outputLock = new object();
        object errorLock = new object();
        using (ManualResetEvent outputClosed = new ManualResetEvent(false))
        using (ManualResetEvent errorClosed = new ManualResetEvent(false))
        {

          using (Process process = new Process())
          {
            process.StartInfo = startInfo;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) {
                if (eventArgs.Data == null) { outputClosed.Set(); return; }
                lock (outputLock) output.AppendLine(eventArgs.Data);
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) {
                if (eventArgs.Data == null) { errorClosed.Set(); return; }
                lock (errorLock) errors.AppendLine(eventArgs.Data);
            };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            while (!process.WaitForExit(1000)) { }
            outputClosed.WaitOne(1500);
            errorClosed.WaitOne(1500);
            if (process.ExitCode == 0) return 0;

            string detail;
            lock (errorLock) detail = errors.ToString().Trim();
            if (detail.Length == 0)
            {
                lock (outputLock) detail = output.ToString().Trim();
            }
            if (detail.Length == 0) detail = "Launcher exited with code " + process.ExitCode + ".";
            throw new InvalidOperationException(detail);
          }
        }
    }

    private static int StartDetachedHost(string root, string[] args)
    {
        string node = Path.Combine(root, "runtime-bin", "node.exe");
        string host = Path.Combine(root, "src", "host.mjs");
        string runtime = Path.GetFullPath(GetArgumentValue(
            args,
            "--runtime-dir",
            Path.Combine(root, "runtime")
        ));
        string database = Path.GetFullPath(GetArgumentValue(
            args,
            "--database",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cc-switch", "cc-switch.db")
        ));
        int port;
        if (!int.TryParse(GetArgumentValue(args, "--port", "0"), out port) || port < 1 || port > 65535)
        {
            throw new ArgumentException("Invalid CDP port.");
        }
        int codexPid;
        if (!int.TryParse(GetArgumentValue(args, "--codex-pid", "0"), out codexPid) || codexPid <= 0)
        {
            throw new ArgumentException("Invalid Codex root PID.");
        }

        RequireFile(node, "bundled node.exe");
        RequireFile(host, "host.mjs");
        Directory.CreateDirectory(runtime);

        string[] hostArguments = new string[] {
            node,
            "--use-env-proxy",
            "--no-warnings",
            "--experimental-sqlite",
            host,
            "--port", port.ToString(),
            "--codex-pid", codexPid.ToString(),
            "--runtime-dir", runtime,
            "--database", database
        };
        StringBuilder commandLine = new StringBuilder();
        foreach (string argument in hostArguments)
        {
            if (commandLine.Length > 0) commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(startup);
        PROCESS_INFORMATION process;
        if (!CreateProcessW(
            node,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            DETACHED_PROCESS,
            IntPtr.Zero,
            root,
            ref startup,
            out process
        ))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to start the detached Node host.");
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return 0;
    }

    private static string GetArgumentValue(string[] args, string name, string fallback)
    {
        for (int index = 1; index < args.Length - 1; index += 1)
        {
            if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
        }
        return fallback;
    }

    private static int VerifyPackage(string root)
    {
        if (!VerifyPayloadManifest(root)) return 4;
        string[] required = new string[] {
            Path.Combine(root, "package.json"),
            Path.Combine(root, "scripts", "launch.ps1"),
            Path.Combine(root, "scripts", "stop-host.ps1"),
            Path.Combine(root, "src", "host.mjs"),
            Path.Combine(root, "src", "usage-normalization.mjs"),
            Path.Combine(root, "runtime-bin", "node.exe")
        };
        for (int index = 0; index < required.Length; index += 1)
        {
            if (!File.Exists(required[index])) return 2;
        }

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = required[required.Length - 1];
        startInfo.Arguments = "--no-warnings --experimental-sqlite -e \"const s=require('node:sqlite');if(process.arch!=='x64'||typeof s.DatabaseSync!=='function')process.exit(4)\"";
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.RedirectStandardOutput = true;
        using (Process process = Process.Start(startInfo))
        {
            process.StandardOutput.ReadToEnd();
            while (!process.WaitForExit(1000)) { }
            return process.ExitCode == 0 ? 0 : 3;
        }
    }

    private static bool VerifyPayloadManifest(string root)
    {
        string manifest = Path.Combine(root, "payload-manifest.sha256");
        if (!File.Exists(manifest) || new FileInfo(manifest).Length > 1024 * 1024) return false;
        if (!FixedHexEquals(FileSha256(manifest), BuildIntegrity.PayloadManifestSha256)) return false;

        string rootPrefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string[] lines = File.ReadAllLines(manifest, new UTF8Encoding(false, true));
        if (lines.Length == 0 || lines.Length > 512) return false;
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < lines.Length; index += 1)
        {
            string line = lines[index];
            if (line.Length < 67 || line[64] != ' ' || line[65] != '*' || !IsLowerHex(line.Substring(0, 64))) return false;
            string relative = line.Substring(66).Replace('/', Path.DirectorySeparatorChar);
            if (relative.Length == 0 || Path.IsPathRooted(relative)) return false;
            string filename = Path.GetFullPath(Path.Combine(root, relative));
            if (!filename.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) || !seen.Add(filename) || !File.Exists(filename)) return false;
            if (!FixedHexEquals(FileSha256(filename), line.Substring(0, 64))) return false;
        }
        return true;
    }

    private static string FileSha256(string filename)
    {
        using (FileStream stream = File.OpenRead(filename))
        using (SHA256 sha256 = SHA256.Create())
        {
            byte[] digest = sha256.ComputeHash(stream);
            StringBuilder result = new StringBuilder(digest.Length * 2);
            for (int index = 0; index < digest.Length; index += 1) result.Append(digest[index].ToString("x2"));
            return result.ToString();
        }
    }

    private static bool IsLowerHex(string value)
    {
        if (value.Length != 64) return false;
        for (int index = 0; index < value.Length; index += 1)
        {
            char character = value[index];
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
        }
        return true;
    }

    private static bool FixedHexEquals(string left, string right)
    {
        if (left == null || right == null || left.Length != right.Length) return false;
        int difference = 0;
        for (int index = 0; index < left.Length; index += 1) difference |= left[index] ^ right[index];
        return difference == 0;
    }

    private static void RequireFile(string path, string label)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("Missing " + label + ": " + path, path);
    }

    private static string BuildArguments(IEnumerable<string> arguments)
    {
        StringBuilder result = new StringBuilder();
        foreach (string argument in arguments)
        {
            if (result.Length > 0) result.Append(' ');
            result.Append(QuoteArgument(argument));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string argument)
    {
        if (argument == null) return "\"\"";
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;

        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        for (int index = 0; index < argument.Length; index += 1)
        {
            char current = argument[index];
            if (current == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (current == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(current);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static void ReportFailure(string root, string detail)
    {
        string message = detail ?? "Unknown launcher error.";
        WriteFailureLog(root, message);

        string display = message.Length > 1800 ? message.Substring(0, 1800) + "..." : message;
        MessageBox.Show(
            "Unable to start Codex CCSwitch Usage.\r\n\r\n" + display,
            WindowTitle,
            MessageBoxButtons.OK,
            MessageBoxIcon.Error
        );
    }

    private static void WriteFailureLog(string root, string message)
    {
        try
        {
            string runtime = Path.Combine(root, "runtime");
            Directory.CreateDirectory(runtime);
            File.WriteAllText(Path.Combine(runtime, "launcher-error.log"), message, new UTF8Encoding(false));
        }
        catch { }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
