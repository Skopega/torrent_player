using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace TorrentPlayerPanel
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            bool createdNew;
            using (var mutex = new Mutex(true, "Local\\TorrentPlayerPanel", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show(
                        "Панель уже запущена.",
                        "Torrent Player Panel",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
        }
    }

    [DataContract]
    internal class PanelConfig
    {
        [DataMember] public int Left;
        [DataMember] public int Top;
        [DataMember] public int Width;
        [DataMember] public int Height;
        [DataMember] public bool AutoRestart = true;
        [DataMember] public bool AutoStartOnLaunch;
    }

    internal class MainForm : Form
    {
        private const string StateStopped = "Остановлен";
        private const string StateStarting = "Запуск...";
        private const string StateRunning = "Работает";
        private const string StateStopping = "Остановка...";
        private const string StateRestarting = "Перезапуск...";
        private const string StateCrashed = "Упал";
        private const string StateBuilding = "Сборка...";

        private static readonly int[] BackoffSec = { 1, 2, 4, 8, 15 };

        private const string BaseUrl = "http://127.0.0.1:3000";

        private readonly string _root;
        private readonly string _nodeExe;
        private readonly string _serverEntry;
        private readonly string _serverDir;
        private readonly string _npmCli;
        private readonly string _configPath;
        private readonly string _logPath;
        private readonly string _healthUrl = BaseUrl + "/api/health";
        private readonly string _shutdownUrl = BaseUrl + "/api/shutdown";

        private readonly PanelConfig _config = new PanelConfig();
        private readonly HttpClient _http = new HttpClient(new HttpClientHandler { UseProxy = false });
        private readonly List<DateTime> _recentCrashes = new List<DateTime>();

        private Process _proc;
        private DateTime _procStartTime;
        private bool _expectedStop;
        private bool _stopping;
        private bool _allowExit;
        private bool _building;

        private int _backoffIndex;
        private int _heartbeatFails;
        private bool _lastHealthOk;
        private string _state = StateStopped;
        private System.Windows.Forms.Timer _restartTimer;
        private readonly System.Windows.Forms.Timer _uptimeTimer;

        private Label _lblState;
        private Label _lblDetail;
        private RichTextBox _log;
        private Button _btnStart;
        private Button _btnStop;
        private Button _btnRestart;
        private Button _btnOpen;
        private Button _btnRebuild;
        private Button _btnClear;
        private Button _btnClearVideo;
        private Button _btnClearAll;
        private CheckBox _chkAutoRestart;
        private CheckBox _chkAutoStart;
        private NotifyIcon _tray;

        public MainForm()
        {
            Text = "Torrent Player Panel";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(560, 360);

            _root = Path.GetDirectoryName(
                AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
            _nodeExe = Path.Combine(_root, "runtime", "node", "node.exe");
            _serverDir = Path.Combine(_root, "server");
            _serverEntry = Path.Combine(_serverDir, "dist", "index.js");
            _npmCli = Path.Combine(_root, "runtime", "node", "node_modules", "npm", "bin", "npm-cli.js");
            _configPath = Path.Combine(_root, "data", "panel.json");
            _logPath = Path.Combine(_root, "data", "logs", "panel.log");

            _http.Timeout = TimeSpan.FromSeconds(3);

            BuildUi();
            LoadConfig();
            ApplyConfig();
            SetupTray();

            _uptimeTimer = new System.Windows.Forms.Timer();
            _uptimeTimer.Interval = 1000;
            _uptimeTimer.Tick += OnUptimeTick;
            _uptimeTimer.Start();

            var heartbeat = new System.Windows.Forms.Timer();
            heartbeat.Interval = 5000;
            heartbeat.Tick += OnHeartbeatTick;
            heartbeat.Start();

            LogLine("INFO", "Панель запущена. Корень приложения: " + _root);
            if (!File.Exists(_nodeExe))
                LogLine("ERROR", "Node.js не найден: " + _nodeExe + ". Запустите setup.bat.");
            if (!File.Exists(_serverEntry))
                LogLine("ERROR", "Сервер не собран: " + _serverEntry + ". Нажмите Rebuild.");
            if (!File.Exists(_npmCli))
                LogLine("WARN", "npm-cli.js не найден: " + _npmCli + ". Rebuild может не сработать.");

            UpdateButtons();
            if (_config.AutoStartOnLaunch && File.Exists(_nodeExe) && File.Exists(_serverEntry))
                Shown += (s, e) => StartServer();
        }

        // ---------- UI ----------

        private void BuildUi()
        {
            var bar = new StatusStrip();
            bar.SizingGrip = false;
            _lblState = new Label();
            _lblState.Text = StateStopped;
            _lblState.AutoSize = true;
            _lblState.Margin = new Padding(8, 2, 16, 2);
            _lblState.Font = new Font(_lblState.Font, FontStyle.Bold);
            _lblDetail = new Label();
            _lblDetail.Text = "";
            _lblDetail.AutoSize = true;
            _lblDetail.Margin = new Padding(8, 2, 8, 2);
            var item = new ToolStripControlHost(_lblState);
            var item2 = new ToolStripControlHost(_lblDetail);
            bar.Items.Add(item);
            bar.Items.Add(item2);
            bar.Items.Add(new ToolStripSeparator());
            var copy = new ToolStripButton("Копировать лог");
            copy.Click += (s, e) =>
            {
                if (_log.Text.Length > 0)
                {
                    Clipboard.SetText(_log.Text);
                    LogLine("INFO", "Лог скопирован в буфер обмена.");
                }
            };
            bar.Items.Add(copy);
            Controls.Add(bar);

            _btnStart = new Button { Text = "Start", Width = 86 };
            _btnStart.Click += (s, e) => StartServer();
            _btnStop = new Button { Text = "Stop", Width = 86 };
            _btnStop.Click += (s, e) => StopServer();
            _btnRestart = new Button { Text = "Restart", Width = 86 };
            _btnRestart.Click += (s, e) => { StopServer(); StartServer(); };
            _btnOpen = new Button { Text = "Open browser", Width = 110 };
            _btnOpen.Click += (s, e) =>
            {
                try { Process.Start("http://localhost:3000"); }
                catch (Exception ex) { LogLine("ERROR", "Открыть браузер: " + ex.Message); }
            };
            _btnRebuild = new Button { Text = "Rebuild", Width = 86 };
            _btnRebuild.Click += (s, e) => Rebuild();
            _btnClear = new Button { Text = "Clear", Width = 70 };
            _btnClear.Click += (s, e) => _log.Clear();
            _btnClearVideo = new Button { Text = "Clear video cache", Width = 120 };
            _btnClearVideo.Click += (s, e) => ClearCache("cache/clear-video", "Видео-кеш", false);
            _btnClearAll = new Button { Text = "Clear all cache", Width = 110 };
            _btnClearAll.Click += (s, e) => ClearCache("cache/clear", "Весь кеш", true);

            _chkAutoRestart = new CheckBox { Text = "Авто-рестарт при падении", AutoSize = true };
            _chkAutoRestart.Checked = _config.AutoRestart;
            _chkAutoRestart.CheckedChanged += (s, e) => { _config.AutoRestart = _chkAutoRestart.Checked; };
            _chkAutoStart = new CheckBox { Text = "Старт сервера при запуске панели", AutoSize = true };
            _chkAutoStart.Checked = _config.AutoStartOnLaunch;
            _chkAutoStart.CheckedChanged += (s, e) => { _config.AutoStartOnLaunch = _chkAutoStart.Checked; };

            var toolbar = new FlowLayoutPanel();
            toolbar.Dock = DockStyle.Top;
            toolbar.Padding = new Padding(8, 8, 8, 8);
            toolbar.AutoSize = true;
            toolbar.Controls.Add(_btnStart);
            toolbar.Controls.Add(_btnStop);
            toolbar.Controls.Add(_btnRestart);
            toolbar.Controls.Add(_btnOpen);
            toolbar.Controls.Add(_btnRebuild);
            toolbar.Controls.Add(_btnClear);
            toolbar.Controls.Add(new Panel { Width = 16, Height = 1 });
            toolbar.Controls.Add(_btnClearVideo);
            toolbar.Controls.Add(_btnClearAll);
            toolbar.Controls.Add(new Panel { Width = 16, Height = 1 });
            toolbar.Controls.Add(_chkAutoRestart);
            toolbar.Controls.Add(_chkAutoStart);
            Controls.Add(toolbar);

            _log = new RichTextBox();
            _log.Dock = DockStyle.Fill;
            _log.ReadOnly = true;
            _log.BackColor = Color.FromArgb(30, 30, 30);
            _log.ForeColor = Color.Gainsboro;
            _log.Font = new Font("Consolas", 9.5f);
            _log.DetectUrls = false;
            _log.WordWrap = false;
            _log.HideSelection = false;
            _log.BorderStyle = BorderStyle.FixedSingle;
            Controls.Add(_log);

            _log.Margin = new Padding(0);
            _log.BringToFront();
        }

        private void SetupTray()
        {
            _tray = new NotifyIcon();
            _tray.Icon = SystemIcons.Application;
            _tray.Text = "Torrent Player Panel";
            var menu = new ContextMenuStrip();
            menu.Items.Add("Открыть панель", null, (s, e) => ShowPanel());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Start", null, (s, e) => StartServer());
            menu.Items.Add("Stop", null, (s, e) => StopServer());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Выход", null, (s, e) =>
            {
                _allowExit = true;
                Close();
            });
            _tray.ContextMenuStrip = menu;
            _tray.DoubleClick += (s, e) => ShowPanel();
            _tray.Visible = true;
        }

        private void ShowPanel()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (WindowState == FormWindowState.Minimized)
            {
                Hide();
                _tray.ShowBalloonTip(
                    1500,
                    "Torrent Player Panel",
                    "Панель свёрнута в трей. Двойной клик по иконке — открыть.",
                    ToolTipIcon.Info);
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_allowExit)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            _tray.Visible = false;
            StopServer();
            SaveConfig();
            base.OnFormClosing(e);
        }

        // ---------- Config ----------

        private void LoadConfig()
        {
            try
            {
                if (!File.Exists(_configPath)) return;
                var ser = new DataContractJsonSerializer(typeof(PanelConfig));
                using (var fs = File.OpenRead(_configPath))
                {
                    var c = ser.ReadObject(fs) as PanelConfig;
                    if (c != null)
                    {
                        _config.Left = c.Left;
                        _config.Top = c.Top;
                        _config.Width = c.Width;
                        _config.Height = c.Height;
                        _config.AutoRestart = c.AutoRestart;
                        _config.AutoStartOnLaunch = c.AutoStartOnLaunch;
                    }
                }
            }
            catch (Exception ex)
            {
                LogLine("WARN", "Не удалось прочитать " + _configPath + ": " + ex.Message);
            }
        }

        private void ApplyConfig()
        {
            _chkAutoRestart.Checked = _config.AutoRestart;
            _chkAutoStart.Checked = _config.AutoStartOnLaunch;
            if (_config.Width > 0 && _config.Height > 0)
            {
                var rect = new Rectangle(_config.Left, _config.Top, _config.Width, _config.Height);
                if (Screen.AllScreens.Length > 0)
                {
                    var scr = Screen.FromRectangle(rect);
                    if (scr.WorkingArea.IntersectsWith(rect) ||
                        scr.WorkingArea.Contains(rect.Location) ||
                        rect.Left >= 0 || rect.Top >= 0)
                    {
                        Bounds = rect;
                    }
                }
                else
                {
                    Bounds = rect;
                }
            }
        }

        private void SaveConfig()
        {
            try
            {
                _config.Left = Bounds.Left;
                _config.Top = Bounds.Top;
                _config.Width = Bounds.Width;
                _config.Height = Bounds.Height;
                Directory.CreateDirectory(Path.GetDirectoryName(_configPath));
                var ser = new DataContractJsonSerializer(typeof(PanelConfig));
                using (var fs = File.Create(_configPath))
                {
                    ser.WriteObject(fs, _config);
                }
            }
            catch (Exception ex)
            {
                LogLine("WARN", "Не удалось сохранить конфиг: " + ex.Message);
            }
        }

        // ---------- Logging ----------

        private void LogFromThread(string level, string msg)
        {
            if (IsDisposed) return;
            if (InvokeRequired)
            {
                try { BeginInvoke((Action<string, string>)(LogLine), level, msg); }
                catch (ObjectDisposedException) { }
                return;
            }
            LogLine(level, msg);
        }

        private void LogLine(string level, string msg)
        {
            if (IsDisposed) return;
            var ts = DateTime.Now.ToString("HH:mm:ss");
            var line = string.Format("{0} {1,-5} {2}", ts, level, msg);
            var color = level == "ERROR" ? Color.OrangeRed
                : level == "WARN" ? Color.Goldenrod
                : level == "INFO" ? Color.Gainsboro
                : level == "SYS" ? Color.CornflowerBlue
                : Color.Gainsboro;
            if (_log != null)
            {
                _log.SelectionStart = _log.TextLength;
                _log.SelectionLength = 0;
                _log.SelectionColor = color;
                _log.AppendText(line + Environment.NewLine);
                _log.ScrollToCaret();
                if (_log.TextLength > 1000000)
                {
                    _log.Text = _log.Text.Substring(_log.TextLength - 500000);
                    _log.SelectionStart = _log.TextLength;
                    _log.SelectionColor = Color.Gainsboro;
                }
            }
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_logPath));
                File.AppendAllText(_logPath, line + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        // ---------- State ----------

        private void SetState(string s)
        {
            _state = s;
            _lblState.Text = s;
            _lblState.ForeColor = s == StateRunning ? Color.SeaGreen
                : s == StateCrashed ? Color.Red
                : s == StateRestarting ? Color.DarkOrange
                : s == StateStarting || s == StateStopping || s == StateBuilding ? Color.DarkGoldenrod
                : Color.Gray;
            UpdateButtons();
        }

        private void UpdateButtons()
        {
            bool running = _proc != null;
            _btnStart.Enabled = !running && !_building;
            _btnStop.Enabled = (running || _restartTimer != null) && !_building;
            _btnRestart.Enabled = running && !_building;
            _btnOpen.Enabled = running && !_building;
            _btnRebuild.Enabled = !_building;
            _btnClear.Enabled = true;
        }

        private void OnUptimeTick(object s, EventArgs e)
        {
            string detail = "";
            if (_proc != null && !_proc.HasExited)
            {
                var up = DateTime.Now - _procStartTime;
                detail = string.Format("PID {0} · uptime {1:hh\\:mm\\:ss} · health {2}",
                    _proc.Id, up, _lastHealthOk ? "OK" : "—");
            }
            else if (_restartTimer != null)
            {
                detail = "ожидание авто-рестарта";
            }
            _lblDetail.Text = detail;
        }

        // ---------- Supervision ----------

        private void StartServer()
        {
            StartServer(true);
        }

        private void StartServer(bool manual)
        {
            if (_stopping) return;
            if (_proc != null && !_proc.HasExited)
            {
                LogLine("WARN", "Сервер уже запущен или ещё завершается.");
                return;
            }
            if (_proc != null) _proc = null;
            CancelRestartTimer();
            if (manual)
            {
                _recentCrashes.Clear();
                _backoffIndex = 0;
            }
            if (!File.Exists(_nodeExe))
            {
                LogLine("ERROR", "Node.js не найден: " + _nodeExe);
                SetState(StateCrashed);
                return;
            }
            if (!File.Exists(_serverEntry))
            {
                LogLine("ERROR", "Сервер не собран: " + _serverEntry + ". Нажмите Rebuild.");
                SetState(StateCrashed);
                return;
            }

            if (HealthQuick())
            {
                LogLine("INFO", "Порт 3000 отвечает на /api/health — гашу старый сервер...");
                try
                {
                    using (var cts = new CancellationTokenSource(4000))
                    {
                        _http.PostAsync(_shutdownUrl, null, cts.Token).Wait();
                    }
                }
                catch { }
                if (!WaitPortFree(10000))
                {
                    LogLine("ERROR", "Порт 3000 не освободился за 10с — старт отменён.");
                    SetState(StateCrashed);
                    return;
                }
                LogLine("INFO", "Порт 3000 свободен.");
            }

            _expectedStop = false;
            StartCore();
        }

        private void StartCore()
        {
            if (_proc != null && !_proc.HasExited)
            {
                LogLine("WARN", "StartCore: сервер уже запущен — пропускаю.");
                return;
            }
            _procStartTime = DateTime.Now;
            _heartbeatFails = 0;
            _lastHealthOk = false;

            var psi = new ProcessStartInfo();
            psi.FileName = _nodeExe;
            psi.Arguments = "\"" + _serverEntry + "\"";
            psi.WorkingDirectory = _serverDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            // Production: ошибки в JSON, без стек-трейсов наружу (панель запускает dist).
            psi.EnvironmentVariables["NODE_ENV"] = "production";
            psi.EnvironmentVariables["TP_DATA_DIR"] = _root + "\\data";

            var p = new Process();
            p.StartInfo = psi;
            p.EnableRaisingEvents = true;
            p.OutputDataReceived += (s, e) =>
            {
                if (e.Data != null) LogFromThread("INFO", e.Data);
            };
            p.ErrorDataReceived += (s, e) =>
            {
                if (e.Data != null) LogFromThread("ERROR", e.Data);
            };
            p.Exited += (s, e) => OnProcExited(p);

            try
            {
                if (!p.Start())
                {
                    LogLine("ERROR", "Не удалось запустить сервер.");
                    SetState(StateCrashed);
                    return;
                }
            }
            catch (Exception ex)
            {
                LogLine("ERROR", "Запуск сервера: " + ex.Message);
                SetState(StateCrashed);
                return;
            }

            _proc = p;
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            SetState(StateStarting);
            LogLine("INFO", "Сервер запущен (PID " + p.Id + "): " + _serverEntry);
        }

        private void OnProcExited(Process p)
        {
            if (IsDisposed) return;
            try { BeginInvoke((Action)(() => HandleExit(p))); }
            catch (ObjectDisposedException) { }
        }

        private void HandleExit(Process p)
        {
            if (p == null) return;
            var code = -1;
            try { code = p.ExitCode; } catch { }
            if (!ReferenceEquals(_proc, p))
            {
                if (!_expectedStop)
                    LogLine("INFO", "Процесс " + p.Id + " завершился (код " + code + ") — старый, игнорирую.");
                return;
            }
            _proc = null;
            LogLine("WARN", "Сервер остановлен (код " + code + ")");

            if (_expectedStop)
            {
                SetState(StateStopped);
                return;
            }
            if (!_config.AutoRestart)
            {
                SetState(StateCrashed);
                LogLine("ERROR", "Авто-рестарт выключен — нажмите Start.");
                return;
            }

            var now = DateTime.Now;
            if (_procStartTime != default(DateTime) &&
                (now - _procStartTime).TotalSeconds > 300 &&
                _backoffIndex > 0)
            {
                _backoffIndex = 0;
                _recentCrashes.Clear();
                LogLine("INFO", "Стабильная работа >5 мин — счётчик рестартов сброшен.");
            }

            _recentCrashes.Add(now);
            while (_recentCrashes.Count > 0 && (now - _recentCrashes[0]).TotalSeconds > 120)
                _recentCrashes.RemoveAt(0);

            if (_recentCrashes.Count >= 5)
            {
                SetState(StateCrashed);
                LogLine("ERROR", "Слишком много падений подряд (" + _recentCrashes.Count +
                    " за 2 мин) — авто-рестарт остановлен. Нажмите Start вручную.");
                return;
            }

            int idx = _backoffIndex < BackoffSec.Length ? _backoffIndex : BackoffSec.Length - 1;
            int delay = BackoffSec[idx];
            _backoffIndex++;
            ScheduleRestart(delay);
        }

        private void ScheduleRestart(int delaySec)
        {
            CancelRestartTimer();
            SetState(StateRestarting);
            LogLine("INFO", "Авто-рестарт через " + delaySec + "с (попытка " + _backoffIndex + ")...");
            _restartTimer = new System.Windows.Forms.Timer();
            _restartTimer.Interval = delaySec * 1000;
            _restartTimer.Tick += (s, e) =>
            {
                CancelRestartTimer();
                if (_expectedStop) return;
                if (_proc != null) return;
                StartCore();
            };
            _restartTimer.Start();
            UpdateButtons();
        }

        private void CancelRestartTimer()
        {
            if (_restartTimer != null)
            {
                _restartTimer.Stop();
                _restartTimer.Dispose();
                _restartTimer = null;
            }
        }

        private void StopServer()
        {
            _expectedStop = true;
            _stopping = true;
            CancelRestartTimer();

            var p = _proc;
            if (p == null || p.HasExited)
            {
                _proc = null;
                _stopping = false;
                SetState(StateStopped);
                return;
            }

            SetState(StateStopping);
            LogLine("INFO", "Останавливаю сервер (PID " + p.Id + ")...");
            try
            {
                using (var cts = new CancellationTokenSource(10000))
                {
                    _http.PostAsync(_shutdownUrl, null, cts.Token).Wait();
                }
            }
            catch { }

            if (!p.WaitForExit(10000))
            {
                LogLine("WARN", "Мягкий стоп не сработал — принудительное завершение.");
                KillForce(p);
                p.WaitForExit(5000);
            }
            if (!p.HasExited)
            {
                // Неубиваемый процесс: не застреваем в StateStopping — освобождаем ссылку,
                // чтобы панель могла повторить попытку (StartServer предупредит о занятом порте).
                LogLine("ERROR", "Процесс " + p.Id + " не удалось остановить принудительно.");
                if (ReferenceEquals(_proc, p)) _proc = null;
                try { p.Dispose(); } catch { }
                _stopping = false;
                SetState(StateCrashed);
            }
            else if (ReferenceEquals(_proc, p))
            {
                _proc = null;
                try { p.Dispose(); } catch { }
                SetState(StateStopped);
            }
            _stopping = false;
        }

        private void KillForce(Process p)
        {
            try
            {
                var psi = new ProcessStartInfo("taskkill", "/F /T /PID " + p.Id);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (var k = Process.Start(psi))
                {
                    if (k != null) k.WaitForExit(5000);
                }
            }
            catch (Exception ex)
            {
                LogLine("ERROR", "taskkill: " + ex.Message);
            }
        }

        // ---------- Heartbeat ----------

        private void OnHeartbeatTick(object s, EventArgs e)
        {
            var p = _proc;
            if (p == null || _stopping) return;
            if (p.HasExited) return;
            CheckHealthAsync();
        }

        private void CheckHealthAsync()
        {
            try
            {
                using (var cts = new CancellationTokenSource(3000))
                {
                    var task = _http.GetAsync(_healthUrl, cts.Token);
                    task.Wait(cts.Token);
                    if (task.Result.IsSuccessStatusCode)
                    {
                        _lastHealthOk = true;
                        if (_heartbeatFails != 0) _heartbeatFails = 0;
                        if (_state == StateStarting) SetState(StateRunning);
                        return;
                    }
                }
                HeartbeatFail();
            }
            catch (Exception ex)
            {
                if (!(ex is OperationCanceledException) &&
                    !(ex is TaskCanceledException) &&
                    !(ex is AggregateException))
                    LogFromThread("WARN", "health check: " + ex.Message);
                HeartbeatFail();
            }
        }

        private void HeartbeatFail()
        {
            if (_stopping || _expectedStop) return;
            _lastHealthOk = false;
            _heartbeatFails++;
            if (_heartbeatFails == 1)
                LogLine("WARN", "Сервер не отвечает на /api/health (1/3)...");
            if (_heartbeatFails >= 3)
            {
                _heartbeatFails = -100;
                var p = _proc;
                if (p != null && !p.HasExited)
                {
                    LogLine("ERROR", "Сервер завис — принудительный рестарт.");
                    _expectedStop = false;
                    KillForce(p);
                }
            }
        }

        // ---------- Build ----------

        private void Rebuild()
        {
            if (_building) return;
            bool wasRunning = _proc != null && !_proc.HasExited;
            // Гасим отложенный авто-рестарт ВСЕГДА (и когда сервер не запущен): иначе
            // тик таймера поднимет сервер во время перезаписи server/dist+web/dist.
            CancelRestartTimer();
            _expectedStop = true;
            if (wasRunning)
            {
                StopServer();
            }
            _building = true;
            SetState(StateBuilding);
            UpdateButtons();
            LogLine("INFO", "=== npm run build ===");

            var thread = new Thread(() => RunBuild(wasRunning));
            thread.IsBackground = true;
            thread.Start();
        }

        private void RunBuild(bool restartAfter)
        {
            try
            {
                if (!File.Exists(_npmCli))
                {
                    LogFromThread("ERROR", "npm-cli.js не найден: " + _npmCli);
                    return;
                }
                var psi = new ProcessStartInfo(_nodeExe, "\"" + _npmCli + "\" run build");
                psi.WorkingDirectory = _root;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                var p = Process.Start(psi);
                p.OutputDataReceived += (s, e) =>
                {
                    if (e.Data != null) LogFromThread("INFO", e.Data);
                };
                p.ErrorDataReceived += (s, e) =>
                {
                    if (e.Data != null) LogFromThread("ERROR", e.Data);
                };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                p.WaitForExit();
                LogFromThread("INFO", "Сборка завершена (код " + p.ExitCode + ").");
            }
            catch (Exception ex)
            {
                LogFromThread("ERROR", "Сборка: " + ex.Message);
            }
            finally
            {
                if (!IsDisposed)
                {
                    try
                    {
                        // Сброс флагов/состояния — на UI-потоке, чтобы не гонять _building
                        // между потоками и не перезаписать более новую сборку.
                        BeginInvoke((Action)(() =>
                        {
                            _building = false;
                            _expectedStop = false;
                            SetState(StateStopped);
                            if (restartAfter) StartServer();
                        }));
                    }
                    catch (ObjectDisposedException) { }
                }
            }
        }

        // ---------- Cache clear ----------

        private void ClearCache(string path, string what, bool confirm)
        {
            if (confirm)
            {
                var r = MessageBox.Show(
                    "Очистить весь кеш?\r\n(постеры, раздачи, видео, метаданные)\r\nТекущие потоки будут остановлены.",
                    "Очистка кеша",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning);
                if (r != DialogResult.Yes) return;
            }
            _btnClearVideo.Enabled = false;
            _btnClearAll.Enabled = false;
            LogLine("INFO", "=== Очистка " + what + " ===");
            var t = new Thread(() => ClearCacheWorker(path, what));
            t.IsBackground = true;
            t.Start();
        }

        private void ClearCacheWorker(string path, string what)
        {
            try
            {
                string url = BaseUrl + "/api/" + path;
                string body;
                using (var cts = new CancellationTokenSource(180000))
                {
                    var task = _http.PostAsync(url, null, cts.Token);
                    task.Wait(cts.Token);
                    body = task.Result.Content.ReadAsStringAsync().Result;
                }
                long freed = -1;
                long bytes = -1;
                try
                {
                    var ser = new DataContractJsonSerializer(typeof(CacheClearResult));
                    using (var ms = new MemoryStream(Encoding.UTF8.GetBytes(body)))
                    {
                        var r = (CacheClearResult)ser.ReadObject(ms);
                        freed = r.freed;
                        bytes = r.bytes;
                    }
                }
                catch { }
                string msg = what + " очищен";
                if (bytes >= 0) msg += ", кеш теперь " + FormatMb(bytes);
                if (freed > 0) msg += ", освобождено " + FormatMb(freed);
                LogFromThread("INFO", msg);
            }
            catch (Exception ex)
            {
                LogFromThread("ERROR", "Очистка " + what + ": " + ex.Message);
            }
            finally
            {
                if (!IsDisposed)
                {
                    try
                    {
                        BeginInvoke((Action)(() =>
                        {
                            _btnClearVideo.Enabled = true;
                            _btnClearAll.Enabled = true;
                        }));
                    }
                    catch (ObjectDisposedException) { }
                }
            }
        }

        private static string FormatMb(long b)
        {
            return (b / 1048576.0).ToString("0.#") + " МБ";
        }

#pragma warning disable 0649
        [DataContract]
        private class CacheClearResult
        {
            [DataMember] public long bytes;
            [DataMember] public long freed;
        }
#pragma warning restore 0649

        // ---------- Health quick ----------

        private bool WaitPortFree(int timeoutMs)
        {
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                if (!HealthQuick()) return true;
                Thread.Sleep(500);
            }
            return !HealthQuick();
        }

        private bool HealthQuick()
        {
            try
            {
                using (var cts = new CancellationTokenSource(2000))
                {
                    var task = _http.GetAsync(_healthUrl, cts.Token);
                    task.Wait(cts.Token);
                    return task.Result.IsSuccessStatusCode;
                }
            }
            catch
            {
                return false;
            }
        }
    }
}
