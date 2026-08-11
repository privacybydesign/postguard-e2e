// Decrypt leg for E4A.PostGuard — which has no decrypt path to drive.
//
// The published .NET SDK is a sealer: PostGuard.Encrypt, Sealed.UploadAsync,
// Sealed.ToBytesAsync, and nothing that opens a container. Decryption needs an
// interactive Yivi session for the recipient's user secret key, and the SDK has
// never shipped one (tracked upstream as postguard#236 / #244).
//
// So this leg asserts the absence instead of skipping it, the same way the
// archival corpus asserts pg-js's refusal of memory-mode containers rather than
// leaving those cases out: a leg that reports success while exercising nothing
// is worse than no leg. Reflection over the package's exported API, so the day
// the SDK grows a reader the sweep goes red with a demand for a real decrypt
// leg — instead of quietly continuing to claim the .NET support window is
// covered.
//
// Prints a single `__RESULT__ <json>` line, like every other flow here.
using System.Reflection;
using System.Text.Json;

// Members that would mean this SDK can open a container. `Sealed.ToBytesAsync`
// is a sealer output and must not match, so this looks for read-side verbs only.
string[] verbs = ["Decrypt", "Open", "Unseal", "Inspect"];

try
{
    var assembly = Assembly.Load("E4A.PostGuard");
    var version = assembly.GetName().Version?.ToString() ?? "unknown";

    var found = new List<string>();
    foreach (var type in assembly.GetExportedTypes())
    {
        foreach (var member in type.GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
        {
            if (member.MemberType is not (MemberTypes.Method or MemberTypes.NestedType))
            {
                continue;
            }
            if (verbs.Any(verb => member.Name.StartsWith(verb, StringComparison.Ordinal)))
            {
                found.Add($"{type.FullName}.{member.Name}");
            }
        }
    }

    if (found.Count > 0)
    {
        throw new InvalidOperationException(
            "E4A.PostGuard now exports a read-side API (" + string.Join(", ", found) +
            ") — this leg only asserts that it did not. Write a real .NET decrypt leg that opens " +
            "the new-stack artifact and drop this probe.");
    }

    Console.WriteLine("__RESULT__ " + JsonSerializer.Serialize(new
    {
        ok = true,
        documentedRefusal = "the published .NET SDK seals only: no Decrypt/Open/Unseal/Inspect API to drive",
        assemblyVersion = version,
    }));
}
catch (Exception ex)
{
    Console.WriteLine("__RESULT__ " + JsonSerializer.Serialize(new { ok = false, error = ex.Message }));
    Environment.Exit(1);
}
