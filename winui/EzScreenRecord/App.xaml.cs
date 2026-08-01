using EzScreenRecord.Models;
using Microsoft.UI.Xaml;

namespace EzScreenRecord;

public partial class App : Application
{
    /// <summary>
    /// Settings are process-wide: the main window, the floating toolbar, the
    /// camera bubble and the annotation overlay all read and write the same
    /// object, and a change in one must be visible to the others immediately
    /// (repositioning the camera mid-take is a shipped feature).
    /// </summary>
    public static AppSettings Settings { get; private set; } = new();

    public static MainWindow? Main { get; private set; }

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        Settings = AppSettings.Load();

        Main = new MainWindow();
        Main.Activate();
    }

    // No hand-written Main here, deliberately.
    //
    // The WinUI targets generate an entry point from App.xaml's
    // ApplicationDefinition, and with WindowsPackageType=None that generated
    // Main already does the unpackaged bootstrap (InitializeComWrappers +
    // Application.Start). Adding our own produces CS0102 "already contains a
    // definition for 'Main'", and DISABLE_XAML_GENERATED_MAIN does not
    // reliably suppress it because the targets append to DefineConstants after
    // the project's own PropertyGroups are evaluated.
}
