TARGET = jptext
OBJS = main.o
CFLAGS = -O2 -G0 -Wall
LIBDIR =
LIBS = -lpspaudio
EXTRA_TARGETS = EBOOT.PBP
PSP_EBOOT_TITLE = JP Text Alignment Test
SFOFLAGS = -s DISC_ID=JPTX00001 -s DISC_VERSION=1.00
PSPSDK = $(shell psp-config --pspsdk-path)
include $(PSPSDK)/lib/build.mak
