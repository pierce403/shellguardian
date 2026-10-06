/* Test-only native close request on the fixture's private Xvfb display. */
#include <X11/Xlib.h>
#include <stdio.h>
#include <string.h>

static int close_shellguardian(Display *display, Window window) {
  char *name = NULL;
  if (XFetchName(display, window, &name) && name) {
    int match = strcmp(name, "ShellGuardian") == 0;
    XFree(name);
    if (match) {
      XEvent event = {0};
      event.xclient.type = ClientMessage;
      event.xclient.window = window;
      event.xclient.message_type = XInternAtom(display, "WM_PROTOCOLS", False);
      event.xclient.format = 32;
      event.xclient.data.l[0] = XInternAtom(display, "WM_DELETE_WINDOW", False);
      event.xclient.data.l[1] = CurrentTime;
      int sent = XSendEvent(display, window, False, NoEventMask, &event);
      XSync(display, False);
      return sent != 0;
    }
  }
  Window root, parent, *children = NULL;
  unsigned int count = 0;
  if (!XQueryTree(display, window, &root, &parent, &children, &count)) return 0;
  int closed = 0;
  for (unsigned int index = 0; index < count && !closed; index++) {
    closed = close_shellguardian(display, children[index]);
  }
  if (children) XFree(children);
  return closed;
}

int main(void) {
  Display *display = XOpenDisplay(NULL);
  if (!display) {
    fputs("Could not connect to the private test display.\n", stderr);
    return 1;
  }
  int closed = close_shellguardian(display, DefaultRootWindow(display));
  XCloseDisplay(display);
  if (!closed) fputs("No ShellGuardian test window was found.\n", stderr);
  return closed ? 0 : 1;
}
