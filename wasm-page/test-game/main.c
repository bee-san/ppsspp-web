/* JP Text Alignment Test — a tiny PSP homebrew that shows two static pages of
 * Japanese text (pre-rendered, see gen_scene.py) so the web shell's OCR overlay
 * can be checked against known glyph positions. Cross toggles the page. */
#include <pspkernel.h>
#include <pspdisplay.h>
#include <pspctrl.h>
#include <pspaudio.h>
#include <string.h>
#include "scene.h"

PSP_MODULE_INFO("JPTextAlign", 0, 1, 0);
PSP_MAIN_THREAD_ATTR(THREAD_ATTR_USER);

#define SCR_W 480
#define SCR_H 272
#define BUF_W 512

/* Test tone so audio capture can be verified: a 440 Hz / 660 Hz sine that alternates
 * every 500 ms, identical on both channels. 44.1 kHz, 1024-sample blocks, sine table
 * (no libm, no VFPU) so it costs the emulated CPU next to nothing. */
#define AUDIO_SAMPLES 1024
#define SINE_N 1024
static short sine_tab[SINE_N];
static short audio_buf[2][AUDIO_SAMPLES * 2];
static void init_sine(void) {
  /* 3rd-order polynomial sine approximation on [0, 2pi) mapped to a table */
  for (int i = 0; i < SINE_N; i++) {
    float x = (float)i / SINE_N;            /* 0..1 = one period */
    float t = x < 0.5f ? x * 4.0f - 1.0f : 3.0f - x * 4.0f; /* triangle -1..1 */
    float v = t * (1.5f - 0.5f * t * t);    /* smooth it towards a sine */
    sine_tab[i] = (short)(v * 9000.0f);
  }
}
static int audio_thread(SceSize args, void *argp) {
  int ch = sceAudioChReserve(PSP_AUDIO_NEXT_CHANNEL, AUDIO_SAMPLES, PSP_AUDIO_FORMAT_STEREO);
  if (ch < 0) return 0;
  unsigned int phase = 0;              /* 16.16 fixed-point table index */
  unsigned int pos = 0;                /* samples played */
  int cur = 0;
  const unsigned int step440 = (unsigned int)(440.0f * SINE_N / 44100.0f * 65536.0f);
  const unsigned int step660 = (unsigned int)(660.0f * SINE_N / 44100.0f * 65536.0f);
  for (;;) {
    short *b = audio_buf[cur];
    for (int i = 0; i < AUDIO_SAMPLES; i++, pos++) {
      phase += ((pos / 22050u) & 1u) ? step660 : step440; /* switch every 0.5 s */
      short v = sine_tab[(phase >> 16) & (SINE_N - 1)];
      b[i * 2] = v;
      b[i * 2 + 1] = v;
    }
    sceAudioOutputBlocking(ch, PSP_AUDIO_VOLUME_MAX, b);
    cur ^= 1;
  }
  return 0;
}

/* Current dialogue line, Shift-JIS, NUL-terminated — what a text hook reads. Kept in .data
 * (not .bss) and volatile so it is a stable, non-optimised memory location. */
volatile unsigned char g_line[LINE_BYTES] = "init";
volatile unsigned int g_line_serial = 0;
static void show_page(int page) {
  const unsigned char *src = LINES[page];
  for (int i = 0; i < LINE_BYTES; i++) g_line[i] = src[i];
  g_line_serial++;
}

static int exit_callback(int arg1, int arg2, void *common) { sceKernelExitGame(); return 0; }
static int callback_thread(SceSize args, void *argp) {
  int cb = sceKernelCreateCallback("Exit Callback", exit_callback, NULL);
  sceKernelRegisterExitCallback(cb);
  sceKernelSleepThreadCB();
  return 0;
}

int main(void) {
  int th = sceKernelCreateThread("update_thread", callback_thread, 0x11, 0xFA0, PSP_THREAD_ATTR_USER, 0);
  if (th >= 0) sceKernelStartThread(th, 0, 0);
  unsigned short *vram = (unsigned short *)0x44000000; /* uncached VRAM */
  sceDisplaySetMode(0, SCR_W, SCR_H);
  sceDisplaySetFrameBuf(vram, BUF_W, PSP_DISPLAY_PIXEL_FORMAT_565, PSP_DISPLAY_SETBUF_NEXTFRAME);
  init_sine();
  int ath = sceKernelCreateThread("audio_thread", audio_thread, 0x12, 0x4000, PSP_THREAD_ATTR_USER, 0);
  if (ath >= 0) sceKernelStartThread(ath, 0, 0);
  sceCtrlSetSamplingCycle(0);
  sceCtrlSetSamplingMode(PSP_CTRL_MODE_ANALOG);
  int page = 0;
  unsigned int prev = 0;
  show_page(page);
  for (;;) {
    SceCtrlData pad;
    sceCtrlReadBufferPositive(&pad, 1);
    if ((pad.Buttons & PSP_CTRL_CROSS) && !(prev & PSP_CTRL_CROSS)) { page = (page + 1) % PAGE_COUNT; show_page(page); }
    prev = pad.Buttons;
    const unsigned short *src = PAGES[page];
    for (int y = 0; y < SCR_H; y++) memcpy(vram + y * BUF_W, src + y * SCR_W, SCR_W * 2);
    sceDisplayWaitVblankStart();
  }
  return 0;
}
