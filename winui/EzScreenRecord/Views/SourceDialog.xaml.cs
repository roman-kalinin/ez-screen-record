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

    /// <summary>
    /// Guards against overlapping loads. SelectorBar raises SelectionChanged
    /// during its own initialisation, so that fires alongside Loaded and both
    /// call LoadAsync; each awaits enumeration and then appends, so every source
    /// appeared twice.
    /// </summary>
    private int _loadGeneration;

    /// <param name="current">
    /// The source in use, so the dialog opens on the matching tab rather than
    /// always on Screens.
    /// </param>
    public SourceDialog(CaptureSourceChoice? current = null)
    {
        InitializeComponent();
        SourceGrid.ItemsSource = _cards;

        if (current is { Kind: CaptureKind.Window })
        {
            ScreensTab.IsSelected = false;
            WindowsTab.IsSelected = true;
        }

        Loaded += async (_, _) => await LoadAsync();
        PrimaryButtonClick += (_, _) => OnClearSelection(this, new RoutedEventArgs());
    }

    private bool ShowingWindows => WindowsTab.IsSelected;

    private async Task LoadAsync()
    {
        // Newest load wins. SelectorBar fires SelectionChanged while it
        // initialises, so this races with the Loaded handler; both awaited
        // enumeration and then appended, which listed every source twice.
        var generation = ++_loadGeneration;

        LoadingRing.IsActive = true;
        SourceGrid.Visibility = Visibility.Collapsed;
        EmptyMessage.Visibility = Visibility.Collapsed;
        MinimizedHint.Visibility = Visibility.Collapsed;
        _cards.Clear();
        Selected = null;
        IsPrimaryButtonEnabled = false;

        // Read the tab state HERE, on the UI thread. Touching WindowsTab from
        // inside Task.Run throws a wrong-thread exception which, because the
        // callers are `async void`, is swallowed -- leaving the spinner turning
        // forever with no error anywhere.
        var wantWindows = ShowingWindows;

        List<CaptureSourceChoice> choices;
        try
        {
            choices = await Task.Run(() => wantWindows
                ? WindowList.Enumerate().Select(CaptureSourceChoice.FromWindow).ToList()
                : MonitorList.Enumerate().Select(CaptureSourceChoice.FromMonitor).ToList());
        }
        catch (Exception ex)
        {
            // Never leave the spinner running. An empty picker the user can
            // close beats a dialog that appears hung.
            LoadingRing.IsActive = false;
            EmptyMessage.Text = $"Could not list sources: {ex.Message}";
            EmptyMessage.Visibility = Visibility.Visible;
            return;
        }

        // A newer load started while this one was awaiting; drop these results
        // rather than appending them to whatever it produced.
        if (generation != _loadGeneration) return;

        _cards.Clear();
        foreach (var choice in choices)
            _cards.Add(new SourceCard { Choice = choice });

        LoadingRing.IsActive = false;

        if (_cards.Count == 0)
        {
            EmptyMessage.Text = wantWindows
                ? "No capturable windows found."
                : "No displays found.";
            EmptyMessage.Visibility = Visibility.Visible;
            return;
        }

        SourceGrid.Visibility = Visibility.Visible;

        // Explain the preview-less cards, but only when there are any.
        MinimizedHint.Visibility = _cards.Any(c => c.Choice.Minimized)
            ? Visibility.Visible
            : Visibility.Collapsed;

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
    /// Clicking a card picks it and closes, matching Electron. Requiring a
    /// second click on a Select button is a step nobody wants.
    /// </summary>
    private async void OnItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not SourceCard card) return;
        Selected = card.Choice;

        if (card.Choice is { Kind: CaptureKind.Window, Minimized: true })
            await WindowList.RestoreForCaptureAsync(card.Choice.WindowHandle);

        Hide();
    }

    /// <summary>Clear the source entirely; a chosen source must be un-choosable.</summary>
    private void OnClearSelection(object sender, RoutedEventArgs e)
    {
        Selected = null;
        Cleared = true;
        Hide();
    }

    /// <summary>True when the user explicitly cleared rather than cancelled.</summary>
    public bool Cleared { get; private set; }

}

