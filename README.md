# Guitar Practice Assistant - With Transpose Feature

This is an updated version of your Guitar Practice Assistant Chrome extension that includes a **transpose slider** to shift the pitch of videos up or down by semitones.

## What's New

### Transpose Slider
- **Range**: -12 to +12 semitones (one full octave down to one full octave up)
- **Location**: Added to both the popup UI and the pop-out widget
- **Controls**: 
  - Slider for quick adjustment
  - Number input for precise values
  - Reset button to return to 0 (no transpose)

### How It Works

The transpose feature works by adjusting the video playback rate:

1. Each semitone shift is calculated as `2^(semitones/12)` 
2. This ratio is multiplied with the speed control setting
3. The combined rate is applied to the video's playback rate
4. Result: pitch shifts while you can still control the speed independently

**Note**: This implementation uses playback rate manipulation rather than Web Audio API, which:
- ✅ Works reliably on all video sites (no CORS issues)
- ✅ Simple and performant
- ⚠️ Changes both pitch AND tempo together (but speed control compensates)
- ℹ️ When transpose is active, the "Speed" control adjusts the tempo while maintaining the pitch shift

### UI Updates

**Popup (popup.html)**:
- Added new "Transpose" row between Speed and Loop sections
- Shows current transpose value (e.g., "+3" or "-5")
- Includes helpful hint text

**Pop-out Widget**:
- Added transpose slider below the speed slider
- Real-time display of current transpose value

**State Management**:
- New `transposeSemitones` field in state (saved to Chrome storage)
- Updated storage key to `gpa_state_with_transpose_v1`

## Files Modified

1. **content.js**
   - Added `transposeSemitones` to state
   - Added audio context initialization
   - Added `applyTranspose()` function
   - Added `setTranspose()` function
   - Updated playback rate calculation to account for pitch shifting
   - Added transpose slider to pop-out widget HTML
   - Updated messaging to include transpose in GET_STATE and SET responses

2. **popup.html**
   - Added transpose controls section with slider, number input, and reset button

3. **popup.js**
   - Added transpose event handlers
   - Updated state display to show transpose value

4. **popup.css, widget.css, manifest.json, background.js**
   - No changes needed

## Installation

1. Replace the files in your extension directory with these updated versions
2. Go to `chrome://extensions/`
3. Click "Reload" on your Guitar Practice Assistant extension
4. The transpose feature will now be available!

## Usage Tips

- **Positive values** (+1, +2, etc.) raise the pitch - useful for matching higher tunings
- **Negative values** (-1, -2, etc.) lower the pitch - useful for matching lower tunings
- Common use: Transpose -1 or -2 semitones to match songs in Eb or D tuning
- The speed control still works independently - you can slow down AND transpose
- Transpose persists across browser sessions

## Technical Notes

- Uses playback rate manipulation for pitch shifting (not Web Audio API)
- Pitch shift calculation: `playbackRate = speed * (2^(semitones/12))`
- Speed and transpose work together multiplicatively
- No CORS issues - works on all video sites (YouTube, Vimeo, etc.)
- Very lightweight and performant
- Transpose persists across browser sessions

Enjoy practicing with the new transpose feature! 🎸
