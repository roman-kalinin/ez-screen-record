using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using EzScreenRecord.Capture;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;

namespace EzScreenRecord.Views;

/// <summary>
/// One card in the picker. Thumbnails load asynchronously and independently, so
/// the grid appears immediately rather than waiting on the slowest window --
/// PrintWindow against an unresponsive app can take hundreds of milliseconds.
/// </summary>
public sealed class SourceCard : INotifyPropertyChanged
{
    // See CaptureSourceChoice: `required` breaks the generated XamlTypeInfo,
    // which constructs bindable types with a parameterless `new`.
    public CaptureSourceChoice Choice { get; init; } = new();
    public string Label => Choice.Label;

    private BitmapImage? _thumbnail;
    public BitmapImage? Thumbnail
    {
        get => _thumbnail;
        set
        {
            _thumbnail = value;
            Notify();
            Notify(nameof(PlaceholderVisibility));
        }
    }

    public Visibility PlaceholderVisibility =>
        _thumbnail is null ? Visibility.Visible : Visibility.Collapsed;

    public event PropertyChangedEventHandler? PropertyChanged;

    private void Notify([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

/// <summary>
/// Visual picker for the capture source.
///
/// Thumbnails matter here: window titles alone
/// ("C:\WINDOWS\system32\cmd.exe") tell you very little about which window you
/// are actually about to record.
/// </summary>
public sealed partial class SourceDialog : ContentDialog
{
    private readonly ObservableCollection<SourceCard> _cards = [];

    public CaptureSourceChoice? Selected { get; private set; }

    public SourceDialog()
    {
        InitializeComponent();
        SourceGrid.ItemsSource = _cards;
        Loaded += async (_, _) => await LoadAsync();
        PrimaryButtonClick += OnPrimaryClick;
    }

    private bool ShowingWindows => WindowsTab.IsSelected;

    private async Task LoadAsync()
    {
        Loading.IsActive = true;
        SourceGrid.Visibility = Visibility.Collapsed;
        _cards.Clear();
        Selected = null;
        IsPrimaryButtonEnabled = false;

        var choices = await Task.Run(() => ShowingWindows
            ? WindowList.Enumerate().Select(CaptureSourceChoice.FromWindow).ToList()
            : MonitorList.Enumerate().Select(CaptureSourceChoice.FromMonitor).ToList());

        foreach (var choice in choices)
            _cards.Add(new SourceCard { Choice = choice });

        Loading.IsActive = false;
        SourceGrid.Visibility = Visibility.Visible;

        // Fill thumbnails in the background so the grid is interactive at once.
        foreach (var card in _cards.ToList())
        {
            _ = card.Choice.LoadThumbnailAsync()
                .ContinueWith(t =>
                {
                    if (t.IsCompletedSuccessfully && t.Result is not null)
                        card.Thumbnail = t.Result;
                }, TaskScheduler.FromCurrentSynchronizationContext());
        }
    }

    private async void OnKindChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
        => await LoadAsync();

    private async void OnRefresh(object sender, RoutedEventArgs e) => await LoadAsync();

    private void OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        Selected = (SourceGrid.SelectedItem as SourceCard)?.Choice;
        IsPrimaryButtonEnabled = Selected is not null;
    }

    /// <summary>
    /// A minimized window cannot be captured until it is restored, so restore it
    /// as part of confirming the selection rather than failing at record time.
    ///
    /// Wired as an event rather than an override: unlike UWP/WPF, WinUI 3's
    /// ContentDialog does not expose OnPrimaryButtonClick as virtual.
    /// </summary>
    private async void OnPrimaryClick(ContentDialog sender, ContentDialogButtonClickEventArgs args)
    {
        if (Selected is not { Kind: CaptureKind.Window, Minimized: true }) return;

        // Hold the dialog open until the window is actually back, so the caller
        // never receives a source that still cannot produce frames.
        var deferral = args.GetDeferral();
        await WindowList.RestoreForCaptureAsync(Selected.WindowHandle);
        deferral.Complete();
    }
}
