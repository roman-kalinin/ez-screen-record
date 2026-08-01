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

    public const string Undo = "\uE7A7";
    public const string Delete = "\uE74D";
    public const string Refresh = "\uE72C";
    public const string Camera = "\uE714";
    public const string Mirror = "\uE13C";
    public const string Minimized = "\uE738";
}
