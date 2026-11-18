// Security facts that are only reachable through WMI: registered antivirus and firewall
// products, WMI event subscriptions (a favourite hiding place for fileless malware), TPM,
// disk encryption and the latest installed update. Read-only. Some parts need administrator
// rights; those report `readable: false` instead of failing.

using System.Globalization;
using System.Management;
using System.Runtime.Versioning;

[SupportedOSPlatform("windows")]
static class SecurityFacts
{
    public record Product(string Name, bool Enabled, bool UpToDate);
    public record Subscription(string Kind, string Name, string Detail);
    public record Section<T>(bool Readable, List<T> Items);
    public record Volume(string Drive, bool Protected);
    public record Facts(
        Section<Product> Antivirus,
        Section<Product> Firewall,
        Section<Subscription> WmiSubscriptions,
        bool? TpmPresent,
        bool? TpmReady,
        Section<Volume> Encryption,
        string? LastUpdate);

    public static Facts Collect() => new(
        Products("AntiVirusProduct"),
        Products("FirewallProduct"),
        Subscriptions(),
        Tpm(out var ready),
        ready,
        Volumes(),
        LastUpdate());

    static IEnumerable<ManagementBaseObject> Query(string scope, string query)
    {
        using var searcher = new ManagementObjectSearcher(scope, query);
        foreach (var item in searcher.Get()) yield return item;
    }

    static Section<Product> Products(string kind)
    {
        try
        {
            var items = Query(@"root\SecurityCenter2", $"SELECT displayName, productState FROM {kind}")
                .Select(p =>
                {
                    var state = Convert.ToUInt32(p["productState"] ?? 0u);
                    // Bits 12–15: 1 means on. Bits 4–7: 0 means definitions are current.
                    return new Product(p["displayName"]?.ToString() ?? "?", ((state >> 12) & 0xF) == 1, ((state >> 4) & 0xF) == 0);
                })
                .ToList();
            return new(true, items);
        }
        catch
        {
            return new(false, new());
        }
    }

    static Section<Subscription> Subscriptions()
    {
        try
        {
            var items = new List<Subscription>();
            foreach (var f in Query(@"root\subscription", "SELECT Name, Query FROM __EventFilter"))
                items.Add(new("filter", f["Name"]?.ToString() ?? "?", f["Query"]?.ToString() ?? ""));
            foreach (var c in Query(@"root\subscription", "SELECT Name, CommandLineTemplate, ExecutablePath FROM CommandLineEventConsumer"))
                items.Add(new("command", c["Name"]?.ToString() ?? "?", $"{c["ExecutablePath"]} {c["CommandLineTemplate"]}".Trim()));
            foreach (var c in Query(@"root\subscription", "SELECT Name, ScriptFileName, ScriptText FROM ActiveScriptEventConsumer"))
            {
                var text = c["ScriptText"]?.ToString() ?? "";
                items.Add(new("script", c["Name"]?.ToString() ?? "?", c["ScriptFileName"]?.ToString() is { Length: > 0 } file ? file : text[..Math.Min(text.Length, 400)]));
            }
            foreach (var b in Query(@"root\subscription", "SELECT Filter, Consumer FROM __FilterToConsumerBinding"))
                items.Add(new("binding", b["Consumer"]?.ToString() ?? "?", b["Filter"]?.ToString() ?? ""));
            return new(true, items);
        }
        catch
        {
            return new(false, new());
        }
    }

    static bool? Tpm(out bool? ready)
    {
        ready = null;
        try
        {
            var tpm = Query(@"root\cimv2\Security\MicrosoftTpm", "SELECT IsEnabled_InitialValue, IsActivated_InitialValue FROM Win32_Tpm").FirstOrDefault();
            if (tpm is null) return false;
            ready = tpm["IsEnabled_InitialValue"] is true && tpm["IsActivated_InitialValue"] is true;
            return true;
        }
        catch
        {
            return null;
        }
    }

    static Section<Volume> Volumes()
    {
        try
        {
            var items = Query(@"root\cimv2\Security\MicrosoftVolumeEncryption", "SELECT DriveLetter, ProtectionStatus FROM Win32_EncryptableVolume")
                .Where(v => v["DriveLetter"] is string { Length: > 0 })
                .Select(v => new Volume((string)v["DriveLetter"], Convert.ToUInt32(v["ProtectionStatus"] ?? 0u) == 1))
                .ToList();
            return new(true, items);
        }
        catch
        {
            return new(false, new());
        }
    }

    /// The most recent update install date, as yyyy-MM-dd.
    static string? LastUpdate()
    {
        try
        {
            DateTime? latest = null;
            foreach (var fix in Query(@"root\cimv2", "SELECT InstalledOn FROM Win32_QuickFixEngineering"))
            {
                var text = fix["InstalledOn"]?.ToString();
                // Windows writes this as M/d/yyyy whatever the system language.
                if (DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out var when) && (latest is null || when > latest))
                    latest = when;
            }
            return latest?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
        catch
        {
            return null;
        }
    }
}
