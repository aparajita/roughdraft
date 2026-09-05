function isApplePlatform(platform?: string | null) {
  if (!platform) return false;

  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function getNavigatorPlatform() {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };

  return (
    navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform
  );
}

export function getAddCommentShortcutLabel(platform?: string | null) {
  return isApplePlatform(platform) ? "Cmd + Return" : "Ctrl + Enter";
}

interface AddCommentShortcutEventLike {
  code: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function matchesAddCommentShortcut(
  event: AddCommentShortcutEventLike,
  platform?: string | null,
) {
  if (event.shiftKey || event.altKey || event.code !== "Enter") {
    return false;
  }

  return isApplePlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
