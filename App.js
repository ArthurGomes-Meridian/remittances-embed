import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import WebView from 'react-native-webview';

WebBrowser.maybeCompleteAuthSession();

const REMITTANCES_BASE_URL = 'https://gcash-embed-staging.meridianapps.dev';
// const REMITTANCES_BASE_URL = 'https://localhost:3000';
const EXPO_PORT = 8081;

// Host(s) do Action Links a interceptar. Deve casar com ACTION_LINK_BASE_URL no remittances.
const ACTION_LINK_HOSTS = __DEV__
  ? ['localhost:3001', '127.0.0.1:3001', 'action.mnai.com']
  : ['action.mnai.com'];

// String-based parsing on purpose: React Native's `new URL()` polyfill (Hermes)
// does not reliably populate `host`/`pathname`, so it would silently reject
// valid Action Link URLs. Match host + `/start` path via string ops instead.
function isActionLinkStart(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  const lower = rawUrl.toLowerCase();
  const hostOk = ACTION_LINK_HOSTS.some(
    (allowed) => lower.indexOf('//' + allowed.toLowerCase()) !== -1,
  );
  if (!hostOk) return false;
  const withoutScheme = rawUrl.replace(/^[a-z]+:\/\//i, '');
  const slashIndex = withoutScheme.indexOf('/');
  const path = (slashIndex === -1 ? '' : withoutScheme.slice(slashIndex))
    .split('?')[0]
    .split('#')[0];
  return /\/start\/?$/.test(path);
}

function getReturnDeeplink() {
  const debuggerHost =
    Constants.expoConfig?.hostUri ?? Constants.manifest?.debuggerHost;
  const localIp = debuggerHost ? debuggerHost.split(':')[0] : '127.0.0.1';
  return `exp://${localIp}:${EXPO_PORT}`;
}

function getEmbedUrl(returnDeeplink) {
  const deeplink = encodeURIComponent(returnDeeplink);
  return `${REMITTANCES_BASE_URL}/login?embed=true&embedDeeplink=${deeplink}`;
}

function buildInjectedJavaScript(hosts) {
  const hostsJson = JSON.stringify(hosts);
  return `
(function () {
  if (window.__remittancesEmbedHook) return;
  window.__remittancesEmbedHook = true;

  var ACTION_HOSTS = ${hostsJson};

  function post(payload) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  // Forward the WebView console + errors to the RN (Metro) terminal so the
  // whole flow is visible in one place during dev.
  ['log', 'warn', 'error'].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      try {
        var parts = Array.prototype.map.call(arguments, function (arg) {
          if (typeof arg === 'string') return arg;
          try { return JSON.stringify(arg); } catch (e) { return String(arg); }
        });
        post({ type: 'console', level: level, text: parts.join(' ') });
      } catch (e) {}
      original.apply(console, arguments);
    };
  });

  window.addEventListener('error', function (event) {
    post({ type: 'console', level: 'error', text: 'window.onerror: ' + (event.message || '') });
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    post({ type: 'console', level: 'error', text: 'unhandledrejection: ' + (reason && reason.message ? reason.message : String(reason)) });
  });

  function isStart(rawUrl) {
    try {
      var url = new URL(rawUrl, window.location.href);
      var hostOk = ACTION_HOSTS.some(function (allowed) {
        return url.host === allowed || url.hostname === allowed;
      });
      return hostOk && /\\/start\\/?$/.test(url.pathname);
    } catch (e) {
      return false;
    }
  }

  function notify(url) {
    var delivered = post({ type: 'action-link-start', url: String(url) });
    post({ type: 'console', level: 'log', text: '[embed-hook] notify action-link-start delivered=' + delivered + ' url=' + String(url) });
    return delivered;
  }

  function intercept(url) {
    if (isStart(url)) {
      notify(url);
      return true;
    }
    return false;
  }

  var loc = window.location;
  var origAssign = loc.assign.bind(loc);
  var origReplace = loc.replace.bind(loc);
  loc.assign = function (url) {
    post({ type: 'console', level: 'log', text: '[embed-hook] location.assign ' + String(url) });
    if (!intercept(url)) origAssign(url);
  };
  loc.replace = function (url) {
    post({ type: 'console', level: 'log', text: '[embed-hook] location.replace ' + String(url) });
    if (!intercept(url)) origReplace(url);
  };

  // window.location.href = ... goes through a setter we cannot override, but the
  // resulting navigation is still caught by onShouldStartLoadWithRequest.

  document.addEventListener(
    'click',
    function (event) {
      var anchor = event.target && event.target.closest
        ? event.target.closest('a[href]')
        : null;
      if (!anchor) return;
      if (intercept(anchor.href)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );

  post({ type: 'console', level: 'log', text: '[embed-hook] installed, ReactNativeWebView=' + !!window.ReactNativeWebView });
})();
true;
`;
}

function notifyWebViewFocus(webViewRef) {
  webViewRef.current?.injectJavaScript(
    "window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); true;",
  );
}

export default function App() {
  const webViewRef = useRef(null);
  const openingRef = useRef(false);
  const returnDeeplink = useMemo(() => getReturnDeeplink(), []);
  const embedUrl = useMemo(
    () => getEmbedUrl(returnDeeplink),
    [returnDeeplink],
  );
  const injectedJavaScript = useMemo(
    () => buildInjectedJavaScript(ACTION_LINK_HOSTS),
    [],
  );

  const openSecureSession = useCallback(
    async (startUrl) => {
      if (openingRef.current) return;
      openingRef.current = true;

      console.log('[remittances-embed] intercept action-link start:', startUrl);

      try {
        const result = await WebBrowser.openAuthSessionAsync(
          startUrl,
          returnDeeplink,
        );
        console.log('[remittances-embed] auth session result:', result.type);

        if (result.type === 'cancel' || result.type === 'dismiss') {
          await WebBrowser.openBrowserAsync(startUrl);
        }
      } catch (error) {
        console.warn(
          '[remittances-embed] openAuthSession failed, falling back to browser',
          error,
        );
        try {
          await WebBrowser.openBrowserAsync(startUrl);
        } catch (browserError) {
          console.error('[remittances-embed] openBrowser failed', browserError);
        }
      } finally {
        openingRef.current = false;
        notifyWebViewFocus(webViewRef);
      }
    },
    [returnDeeplink],
  );

  const handleActionLinkStart = useCallback(
    (startUrl) => {
      if (!isActionLinkStart(startUrl)) return;
      webViewRef.current?.stopLoading();
      void openSecureSession(startUrl);
    },
    [openSecureSession],
  );

  const handleShouldStartLoadWithRequest = useCallback(
    (request) => {
      if (isActionLinkStart(request.url)) {
        handleActionLinkStart(request.url);
        return false;
      }
      return true;
    },
    [handleActionLinkStart],
  );

  const handleNavigationStateChange = useCallback(
    (navState) => {
      if (isActionLinkStart(navState.url)) {
        handleActionLinkStart(navState.url);
      }
    },
    [handleActionLinkStart],
  );

  const handleMessage = useCallback(
    (event) => {
      const raw = event.nativeEvent.data;
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        console.log('[remittances-embed] non-JSON message:', raw);
        return;
      }

      if (data?.type === 'console') {
        const level =
          data.level === 'error'
            ? 'error'
            : data.level === 'warn'
              ? 'warn'
              : 'log';
        console[level]('[webview]', data.text);
        return;
      }

      if (data?.type === 'action-link-start') {
        console.log(
          '[remittances-embed] received action-link-start message:',
          data.url,
          'matches=',
          isActionLinkStart(data.url),
        );
        if (data.url) handleActionLinkStart(data.url);
      }
    },
    [handleActionLinkStart],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        notifyWebViewFocus(webViewRef);
      }
    });
    return () => subscription.remove();
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <WebView
        ref={webViewRef}
        source={{ uri: embedUrl }}
        style={styles.webview}
        originWhitelist={['*']}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        cacheEnabled={false}
        injectedJavaScript={injectedJavaScript}
        injectedJavaScriptBeforeContentLoaded={injectedJavaScript}
        onMessage={handleMessage}
        onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
        onNavigationStateChange={handleNavigationStateChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  webview: {
    flex: 1,
  },
});
