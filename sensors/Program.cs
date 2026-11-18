// DelphEye sensor helper.
//
// Reads every hardware sensor LibreHardwareMonitor can reach (temperatures, clocks, loads,
// fan speeds, power, storage health, battery) and prints one JSON line per second on stdout.
// It only reads. It exits as soon as its parent closes stdin, so it never outlives DelphEye.
//
// Usage: DelphEye.Sensors.exe [--once | --security]

using System.Management;
using System.Text.Json;
using System.Text.Json.Serialization;
using LibreHardwareMonitor.Hardware;

if (args.Contains("--security"))
{
    // One-shot: WMI security facts for DelphEye's protection check.
    Console.Out.WriteLine(JsonSerializer.Serialize(SecurityFacts.Collect(), Json.Options));
    return 0;
}

var once = args.Contains("--once");
var stop = new CancellationTokenSource();

if (!once)
{
    // The parent closing our stdin (or dying) is the signal to leave.
    new Thread(() =>
    {
        try
        {
            while (Console.In.ReadLine() is { } line && line.Trim() != "quit") { }
        }
        catch (IOException) { }
        stop.Cancel();
    }) { IsBackground = true }.Start();
}

var computer = new Computer
{
    IsCpuEnabled = true,
    IsGpuEnabled = true,
    IsMemoryEnabled = true,
    IsMotherboardEnabled = true,
    IsControllerEnabled = true,
    IsStorageEnabled = true,
    IsBatteryEnabled = true,
    IsPsuEnabled = true,
};

try
{
    computer.Open();
}
catch (Exception e)
{
    Emit(new { error = "open", message = e.Message });
    return 1;
}

var disks = ReadDiskHealth();
var windowsCpu = new WindowsCpu();
if (!once) windowsCpu.Start(stop.Token);
var elevated = new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent())
    .IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);

do
{
    var hardware = new List<HardwareOut>();
    foreach (var item in computer.Hardware)
    {
        Collect(item, null, hardware);
    }
    Emit(new Frame(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), elevated, hardware, disks, windowsCpu.Latest));
    if (once) break;
    try
    {
        await Task.Delay(1000, stop.Token);
    }
    catch (TaskCanceledException) { }
} while (!stop.IsCancellationRequested);

computer.Close();
return 0;

static void Collect(IHardware item, string? parent, List<HardwareOut> into)
{
    try
    {
        item.Update();
    }
    catch
    {
        // One misbehaving device must not stop the rest from being read.
        return;
    }
    var sensors = item.Sensors
        .Where(s => s.Value.HasValue && float.IsFinite(s.Value.Value))
        .Select(s => new SensorOut(s.Identifier.ToString(), s.Name, s.SensorType.ToString(), s.Value!.Value))
        .ToList();
    into.Add(new HardwareOut(item.Identifier.ToString(), item.Name, item.HardwareType.ToString(), parent, sensors));
    foreach (var sub in item.SubHardware)
    {
        Collect(sub, item.Name, into);
    }
}

// Windows' own verdict on each physical disk; readable without administrator rights.
static List<DiskOut> ReadDiskHealth()
{
    var result = new List<DiskOut>();
    try
    {
        using var searcher = new ManagementObjectSearcher(@"root\Microsoft\Windows\Storage", "SELECT FriendlyName, MediaType, HealthStatus, Size FROM MSFT_PhysicalDisk");
        foreach (var disk in searcher.Get())
        {
            var health = Convert.ToInt32(disk["HealthStatus"] ?? 5) switch { 0 => "healthy", 1 => "warning", 2 => "unhealthy", _ => "unknown" };
            var media = Convert.ToInt32(disk["MediaType"] ?? 0) switch { 3 => "hdd", 4 => "ssd", 5 => "scm", _ => "unknown" };
            result.Add(new DiskOut(disk["FriendlyName"]?.ToString() ?? "?", media, health, Convert.ToUInt64(disk["Size"] ?? 0UL)));
        }
    }
    catch
    {
        // Older systems lack this namespace; health then comes from the sensors alone.
    }
    return result;
}

static void Emit(object value)
{
    Console.Out.WriteLine(JsonSerializer.Serialize(value, Json.Options));
    Console.Out.Flush();
}

record SensorOut(string Id, string Name, string Type, float Value);
record HardwareOut(string Id, string Name, string Type, string? Parent, List<SensorOut> Sensors);
record DiskOut(string Name, string Media, string Health, ulong Size);
record Frame(long At, bool Elevated, List<HardwareOut> Hardware, List<DiskOut> Disks, CpuOut? Windows);

static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
