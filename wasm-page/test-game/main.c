/* JP Text Alignment Test — a tiny PSP homebrew that shows two static pages of
 * Japanese text (pre-rendered, see gen_scene.py) so the web shell's OCR overlay
 * can be checked against known glyph positions. Cross toggles the page. */
#include <pspkernel.h>
#include <pspdisplay.h>
#include <pspctrl.h>
#include <string.h>
#include "scene.h"

PSP_MODULE_INFO("JPTextAlign", 0, 1, 0);
PSP_MAIN_THREAD_ATTR(THREAD_ATTR_USER);

#define SCR_W 480
#define SCR_H 272
#define BUF_W 512

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
  sceCtrlSetSamplingCycle(0);
  sceCtrlSetSamplingMode(PSP_CTRL_MODE_ANALOG);
  int page = 0;
  unsigned int prev = 0;
  for (;;) {
    SceCtrlData pad;
    sceCtrlReadBufferPositive(&pad, 1);
    if ((pad.Buttons & PSP_CTRL_CROSS) && !(prev & PSP_CTRL_CROSS)) page = (page + 1) % PAGE_COUNT;
    prev = pad.Buttons;
    const unsigned short *src = PAGES[page];
    for (int y = 0; y < SCR_H; y++) memcpy(vram + y * BUF_W, src + y * SCR_W, SCR_W * 2);
    sceDisplayWaitVblankStart();
  }
  return 0;
}
