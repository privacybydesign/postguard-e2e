// Flow program for the "modern" E4A.PostGuard API. Copied into each version's
// sandbox project and run with `dotnet run`. Prints a single
// `__RESULT__ <json>` line. Mirrors postguard-js's `examples/pg-dotnet`
// (Flow 1: silent encrypt + upload, the non-interactive server-facing path).
// That example was `postguard-examples/pg-dotnet` until the repo was folded into
// postguard-js and archived.
using E4A.PostGuard;
using E4A.PostGuard.Models;

var pkgUrl = Environment.GetEnvironmentVariable("PG_PKG_URL") ?? "https://pkg.staging.postguard.eu";
var cryptifyUrl = Environment.GetEnvironmentVariable("PG_CRYPTIFY_URL") ?? "https://storage.staging.postguard.eu";
var apiKey = Environment.GetEnvironmentVariable("PG_API_KEY") ?? "";
var citizen = Environment.GetEnvironmentVariable("PG_CITIZEN_EMAIL") ?? "citizen@example.com";
var org = Environment.GetEnvironmentVariable("PG_ORGANISATION_EMAIL") ?? "noreply@example.org";

try
{
    var pg = new PostGuard(new PostGuardConfig { PkgUrl = pkgUrl, CryptifyUrl = cryptifyUrl });

    var files = new List<PgFile>
    {
        new("vm.txt", new MemoryStream("version-matrix probe"u8.ToArray())),
    };

    var sealed_ = pg.Encrypt(new EncryptInput
    {
        Files = files,
        Recipients =
        [
            pg.Recipient.Email(citizen),
            pg.Recipient.EmailDomain(org),
        ],
        Sign = pg.Sign.ApiKey(apiKey),
    });

    var result = await sealed_.UploadAsync();
    Console.WriteLine("__RESULT__ " + System.Text.Json.JsonSerializer.Serialize(new { ok = true, uuid = result.Uuid }));
}
catch (Exception ex)
{
    Console.WriteLine("__RESULT__ " + System.Text.Json.JsonSerializer.Serialize(new { ok = false, error = ex.Message }));
    Environment.Exit(1);
}
