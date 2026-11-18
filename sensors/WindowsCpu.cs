// What Windows itself knows about the processor, readable without drivers or administrator rights:
// the real average clock (including turbo) and the ACPI thermal zones the firmware reports.
//
// Read through PDH directly: .NET's PerformanceCounter class goes through the performance
// registry, which hangs forever on some machines. Everything runs on its own thread anyway,
// so if PDH stalls too, frames simply go out without these figures.

using System.Runtime.InteropServices;

sealed class WindowsCpu
{
    private volatile CpuOut? latest;

    public CpuOut? Latest => latest;

    public void Start(CancellationToken stop)
    {
        new Thread(() => Loop(stop)) { IsBackground = true, Name = "windows-cpu" }.Start();
    }

    private void Loop(CancellationToken stop)
    {
        if (Pdh.PdhOpenQuery(null, IntPtr.Zero, out var query) != 0) return;
        try
        {
            var perf = Pdh.Add(query, @"\Processor Information(_Total)\% Processor Performance");
            var nominal = Pdh.Add(query, @"\Processor Information(_Total)\Processor Frequency");
            var utility = Pdh.Add(query, @"\Processor Information(_Total)\% Processor Utility");
            var precise = Pdh.Add(query, @"\Thermal Zone Information(*)\High Precision Temperature");
            var coarse = precise == IntPtr.Zero ? Pdh.Add(query, @"\Thermal Zone Information(*)\Temperature") : IntPtr.Zero;
            var passive = Pdh.Add(query, @"\Thermal Zone Information(*)\% Passive Limit");
            if (perf == IntPtr.Zero && precise == IntPtr.Zero && coarse == IntPtr.Zero) return;

            // Rate counters need two samples before they mean anything.
            Pdh.PdhCollectQueryData(query);
            while (!stop.IsCancellationRequested)
            {
                Thread.Sleep(1000);
                if (Pdh.PdhCollectQueryData(query) != 0) continue;
                var limits = Pdh.Array(passive);
                var zones = new List<ZoneOut>();
                foreach (var (instance, raw) in Pdh.Array(precise != IntPtr.Zero ? precise : coarse))
                {
                    var celsius = (precise != IntPtr.Zero ? raw / 10.0 : raw) - 273.15;
                    // Firmware fills unused zones with nonsense such as -273 °C.
                    if (celsius is < 1 or > 130) continue;
                    var name = instance.Replace(@"\_TZ.", "").Replace(@"\_tz.", "").Trim('\\');
                    zones.Add(new ZoneOut(name, Math.Round(celsius, 1), limits.TryGetValue(instance, out var cap) ? cap : null));
                }
                var p = Pdh.Value(perf);
                var n = Pdh.Value(nominal);
                latest = new CpuOut(p > 0 ? Math.Round(p.Value, 1) : null, n > 0 ? n : null, Pdh.Value(utility) is { } u ? Math.Round(u, 1) : null, zones);
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"windows-cpu: {e.Message}");
        }
        finally
        {
            Pdh.PdhCloseQuery(query);
        }
    }
}

static class Pdh
{
    private const uint PDH_FMT_DOUBLE = 0x00000200;
    private const uint PDH_FMT_NOCAP100 = 0x00008000;
    private const uint PDH_MORE_DATA = 0x800007D2;

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    public static extern uint PdhOpenQuery(string? source, IntPtr user, out IntPtr query);

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    private static extern uint PdhAddEnglishCounter(IntPtr query, string path, IntPtr user, out IntPtr counter);

    [DllImport("pdh.dll")]
    public static extern uint PdhCollectQueryData(IntPtr query);

    [DllImport("pdh.dll")]
    public static extern uint PdhCloseQuery(IntPtr query);

    [DllImport("pdh.dll")]
    private static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, out uint type, out FmtValue value);

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    private static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint bytes, out uint count, IntPtr items);

    [StructLayout(LayoutKind.Sequential)]
    private struct FmtValue
    {
        public uint Status;
        public double Double;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FmtItem
    {
        public IntPtr Name;
        public FmtValue Value;
    }

    public static IntPtr Add(IntPtr query, string path) =>
        PdhAddEnglishCounter(query, path, IntPtr.Zero, out var counter) == 0 ? counter : IntPtr.Zero;

    public static double? Value(IntPtr counter)
    {
        if (counter == IntPtr.Zero) return null;
        if (PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, out _, out var value) != 0 || value.Status != 0) return null;
        return double.IsFinite(value.Double) ? value.Double : null;
    }

    /// Every instance of a wildcard counter, by instance name.
    public static Dictionary<string, double> Array(IntPtr counter)
    {
        var result = new Dictionary<string, double>();
        if (counter == IntPtr.Zero) return result;
        uint bytes = 0;
        if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, ref bytes, out _, IntPtr.Zero) != PDH_MORE_DATA || bytes == 0) return result;
        var buffer = Marshal.AllocHGlobal((int)bytes);
        try
        {
            if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, ref bytes, out var count, buffer) != 0) return result;
            var size = Marshal.SizeOf<FmtItem>();
            for (var i = 0; i < count; i++)
            {
                var item = Marshal.PtrToStructure<FmtItem>(buffer + i * size);
                var name = Marshal.PtrToStringUni(item.Name);
                if (name is not null && item.Value.Status == 0 && double.IsFinite(item.Value.Double)) result[name] = item.Value.Double;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return result;
    }
}

/// <param name="Perf">Work done relative to the nominal clock, in percent; above 100 means turbo.</param>
/// <param name="NominalMhz">The nominal clock Windows measures performance against.</param>
/// <param name="Utility">Processor utility in percent; can exceed 100 under turbo.</param>
record CpuOut(double? Perf, double? NominalMhz, double? Utility, List<ZoneOut> Zones);

/// <param name="Passive">Firmware's passive-cooling cap in percent; below 100 means it is slowing the CPU down.</param>
record ZoneOut(string Name, double Temp, double? Passive);
