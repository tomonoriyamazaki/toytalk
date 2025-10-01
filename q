warning: in the working copy of 'app/.expo/devices.json', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'app/.expo/types/router.d.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'app/expo-env.d.ts', LF will be replaced by CRLF the next time Git touches it
[1mdiff --git a/app/.expo/devices.json b/app/.expo/devices.json[m
[1mindex 1f3487e..c1963f0 100644[m
[1m--- a/app/.expo/devices.json[m
[1m+++ b/app/.expo/devices.json[m
[36m@@ -2,7 +2,7 @@[m
   "devices": [[m
     {[m
       "installationId": "15EA11AB-16CD-4299-BFF6-33D55F36E355",[m
[31m-      "lastUsed": 1759230127630[m
[32m+[m[32m      "lastUsed": 1759284784191[m
     },[m
     {[m
       "installationId": "3CD6DB2F-7981-4551-BD3C-C53F7E1EFC4A",[m
[36m@@ -23,22 +23,6 @@[m
     {[m
       "installationId": "4D09832C-22FC-4A7F-AC64-5524470628DF",[m
       "lastUsed": 1756707804324[m
[31m-    },[m
[31m-    {[m
[31m-      "installationId": "6F783077-139E-481A-A23F-FAB765BF5B94",[m
[31m-      "lastUsed": 1756691106459[m
[31m-    },[m
[31m-    {[m
[31m-      "installationId": "C5CF93A2-25D1-48D8-8FFA-D22A9728A7C2",[m
[31m-      "lastUsed": 1756689824973[m
[31m-    },[m
[31m-    {[m
[31m-      "installationId": "29791EF4-7CFE-448C-8DEB-0800A8AD2AC2",[m
[31m-      "lastUsed": 1756664168252[m
[31m-    },[m
[31m-    {[m
[31m-      "installationId": "174A46B1-047D-4D37-9FC2-C9B341721931",[m
[31m-      "lastUsed": 1756656529012[m
     }[m
   ][m
 }[m
[1mdiff --git a/app/app/(tabs)/chat.tsx b/app/app/(tabs)/chat.tsx[m
[1mindex caa16ff..36f41f6 100644[m
[1m--- a/app/app/(tabs)/chat.tsx[m
[1m+++ b/app/app/(tabs)/chat.tsx[m
[36m@@ -531,7 +531,6 @@[m [mexport default function Chat() {[m
       partial ||[m
       finalText[m
     ).trim();[m
[31m-    if (textToSend) send(textToSend);[m
 [m
     sonioxFinalBufRef.current = "";[m
     sonioxNonFinalBufRef.current = "";[m
[36m@@ -621,6 +620,7 @@[m [mexport default function Chat() {[m
     });[m
     if(DEBUG)setLog(L => [...L, `enqueueAudio wrote: ${path}`]);   [m
     queueRef.current.push({ uri: path });[m
[32m+[m[32m    if (DEBUG) setLog(L => [...L, `queue length: ${queueRef.current.length}`]);[m
     if (!playingRef.current) playLoop();[m
   };[m
 [m
[36m@@ -641,6 +641,7 @@[m [mexport default function Chat() {[m
           let finished = false;[m
 [m
           sound.setOnPlaybackStatusUpdate((st) => {[m
[32m+[m[32m            if (DEBUG) setLog(L => [...L, `status: ${JSON.stringify(st)}`]);[m
             if (st.isLoaded && st.didJustFinish && !finished) {[m
               finished = true;[m
               sound.unloadAsync().then(() => {[m
[36m@@ -650,19 +651,14 @@[m [mexport default function Chat() {[m
             }[m
           });[m
 [m
[31m-          sound.playAsync().then(() => {[m
[31m-            if (DEBUG) setLog(L => [...L, `sound.playAsync called: ${uri}`]);[m
[31m-          });[m
[31m-[m
[31m-          // 念のためタイムアウトで解放（2秒後）[m
[31m-          setTimeout(() => {[m
[31m-            if (!finished) {[m
[31m-              sound.unloadAsync().then(() => {[m
[31m-                if (DEBUG) setLog(L => [...L, `sound timeout-unloaded: ${uri}`]);[m
[31m-                resolve();[m
[31m-              });[m
[32m+[m[32m          (async () => {[m
[32m+[m[32m            try {[m
[32m+[m[32m              await sound.playAsync();[m
[32m+[m[32m              if (DEBUG) setLog(L => [...L, `sound.playAsync success: ${uri}`]);[m
[32m+[m[32m            } catch (e) {[m
[32m+[m[32m              setLog(L => [...L, `sound.playAsync error: ${e}`]);[m
             }[m
[31m-          }, 2000);[m
[32m+[m[32m          })();[m
         });[m
       }[m
     } catch (e: any) {[m
