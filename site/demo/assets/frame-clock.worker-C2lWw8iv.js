(function(){"use strict";let t=null;self.onmessage=e=>{if(t!==null&&(clearInterval(t),t=null),e.data.stop)return;const l=e.data.interval??33;t=setInterval(()=>self.postMessage(0),l)}})();
