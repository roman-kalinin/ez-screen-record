namespace EzScreenRecord.Views;

/// <summary>
/// Segoe Fluent Icons codepoints used by the app.
///
/// Named constants rather than literal glyphs inline: the characters live in
/// the Unicode private-use area, so they render as blanks or tofu in most
/// editors and diffs, and are easily mangled when a file is edited. A
/// codepoint escape survives every round-trip and says what it is.
/// </summary>
internal static class Glyphs
{
    public const string Record = "\uE7C8";
    public const string Stop = "\uE71A";
    public const string Pause = "\uE769";

    public const string Pen = "\uE70F";
    public const string Highlighter = "\uE7E6";
    public const string Arrow = "\uE741";
    public const string Rectangle = "\uE739";
    public const string Ellipse = "\uEA3A";
    public const string Eraser = "\uE75C";

    public const string Delete = "\uE74D";
    public const string Mirror = "\uE13C";

    public const string Accept = "\uE73E";
    public const string Cancel = "\uE711";

    public const string ChevronUp = "\uE70E";
    public const string Mic = "\uE720";
    public const string MicOff = "\uEC54";
    public const string Video = "\uE714";
    public const string VideoOff = "\uED1A";
    public const string Desktop = "\uE7F4";
    public const string ImageAdd = "\uEE71";
    public const string Ink = "\uEE56";
    public const string Settings = "\uE713";
    public const string Question = "\uE9CE";
    public const string Pin = "\uE718";
    public const string Minimize = "\uE921";
    public const string Close = "\uE8BB";
    public const string Folder = "\uE838";
    public const string Grip = "\uE76F";
    public const string Circle = "\uEA3A";
    public const string Square = "\uE739";
    public const string Shadow = "\uEA3B";
    public const string Play = "\uE768";
}
