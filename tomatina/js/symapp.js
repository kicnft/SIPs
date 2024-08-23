
let onSocketResumed;
let onSocketMessage;
let onPhysicalMessage;
let onStatusChange;
let onVisible;
let nodeFetchTimout;
let selectedNode;
let currentWebsocket;

async function startSymbolApplication(config,onReady,cb1,cb2,cb3,cb4,cb5){

	//コールバック関数登録
	onStatusChange = cb1;
	onPhysicalMessage = cb2
	onSocketMessage = cb3;
	onSocketResumed = cb4;
	onVisible = cb5;

	//nodeFetchのタイムアウト設定
	nodeFetchTimout = config.timeout;

	//ノード選択
	selectedNode = await selectNode(
		config.nodes,
		config.selectNodeCount,
		config.retryCount,
		config.heightDiffThreshold
	);
	onReady(selectedNode);
}

document.addEventListener("visibilitychange", async function() {
	if (document.visibilityState === 'visible') {
		const readyState = currentWebsocket.socket.readyState;
		if(readyState == 1){
			const timeoutId = setTimeout(async() => {
				if(readyState == 3){
					currentWebsocket = await connectWebSocket(selectedNode.url);
					onSocketResumed(currentWebsocket);
				}
			}, 100);
		}else{
			currentWebsocket = await connectWebSocket(selectedNode.url);
			onSocketResumed(currentWebsocket);
		}
		onVisible();
	}
});

function getRandomNodes(nodes,count) {

	const randomNodes = [];
	const availableIndices = new Set();

	while (availableIndices.size < count && availableIndices.size < nodes.length) {
		const index = Math.floor(Math.random() * nodes.length);

		if (!availableIndices.has(index)) {
			availableIndices.add(index);
			randomNodes.push(nodes[index]);
		}
	}
	return randomNodes;
}

async function selectNode(nodes,selectCount = 5, retries = 5,heightDiffThreshold = 1) {
	const selectedNodes = getRandomNodes(nodes, selectCount); // n個のノードを取得する関数（任意の実装）
	const targetNode = selectedNodes[0]; // 最初のノードを接続候補のノードとする

	try {
		const results = await Promise.all([
			checkNodeHealth(targetNode),
			checkNetworkProperties(targetNode), // ネットワークプロパティをチェックする関数
			...selectedNodes.map((node) => checkChainInfo(node)),
			...selectedNodes.map((node) => checkLastBlockHash(node)),
		]);

		// ターゲットノードと他のノードのheightの差を確認する
		const heights = results.slice(2, 2 +selectedNodes.length); 
		for (let i = 1; i < heights.length; i++) {
			const heightDiff = Math.abs(heights[i] - heights[0]);
			if (heightDiff > heightDiffThreshold) {
				throw new Error("Height difference is greater than the threshold");
			}
		}

		// ターゲットノードと他のノードのhash値を確認する
		const hashes = results.slice(2 +selectedNodes.length); 
		for (let i = 1; i < hashes.length; i++) {
			if (hashes[0] !== hashes[i]) {
				throw new Error("hashes are difference");
			}
		}

		currentWebsocket = await connectWebSocket(targetNode);
		return {
			url:targetNode,
			network:results[1],
			socket:currentWebsocket
		};

		// `symbolSocketUid`を使用した処理を続ける
		// WebSocketの処理を行う
	} catch (error) {
		if (retries > 0) {
			onStatusChange({name:"retry",targetNode:targetNode,error:error.message});
			return await selectNode(nodes, selectCount,retries - 1,heightDiffThreshold);
		} else {
			onStatusChange({name:"over"});
		}
	}
}

//タイムアウト機能つきfetch
function nodeFetch(nodeUrl, method = 'GET', data = null) {

	const timeout = nodeFetchTimout; // タイムアウト値
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, timeout);

	const requestOptions = {
		method,
		signal: controller.signal
	};

	
/*	
	const requestOptions = {
		method,
		headers: {
			'Content-Type': 'application/json' // リクエストヘッダーに適切なContent-Typeを指定します
		},
		signal: controller.signal
	};


	const requestOptions = {
		method,
		signal: controller.signal
	};
*/
	if (method === 'POST' || method === 'PUT') {
		requestOptions.headers = {
			'Content-Type': 'application/json' // リクエストヘッダーに適切なContent-Typeを指定します
		};
		requestOptions.body = JSON.stringify(data); // リクエストボディにデータを含める場合は適切なデータ形式に変換する必要があります
	}

	return fetch(nodeUrl, requestOptions)
	.then(response => {
		clearTimeout(timeoutId);
		if (!response.ok) {
			throw new Error("Error: " + response.status);
		}
		return response.text();
	})
	.catch(error => {
		if (error.name === "AbortError") {
			throw new Error("Timeout");
		}
		throw error;
	});
}

function checkNodeHealth(node) {
	const healthEndpoint = node + "/node/health";
	return nodeFetch(healthEndpoint)
		.then((response) => {
			const { status } = JSON.parse(response);
			const isNodeUp = status.apiNode === "up";
			const isDbUp = status.db === "up";
			return isNodeUp && isDbUp;
		});
}

function checkNetworkProperties(node) {
	const propertiesEndpoint = node + "/network/properties";
	return nodeFetch(propertiesEndpoint)
		.then((response) => {
			const { network } = JSON.parse(response);
			const { chain } = JSON.parse(response);
			network.currencyMosaicId = chain.currencyMosaicId;
			return network;
		});
}

function checkChainInfo(node) {
	const infoEndpoint = node + "/chain/info";
	return nodeFetch(infoEndpoint)
		.then((response) => {
			const { height } = JSON.parse(response);
			return parseInt(height);
		});
}

function checkLastBlockHash(node) {
	const infoEndpoint = node + "/blocks?order=desc";
	return nodeFetch(infoEndpoint)
		.then((response) => {
			const parsedResponse = JSON.parse(response);
			return parsedResponse.data[0].meta.hash;
		});
}

let isSocketFailed = false;
function connectWebSocket(targetNode) {

	return new Promise((resolve, reject) => {
		const wsEndpoint = targetNode.replace("http", "ws") + "/ws";
		const socket = new WebSocket(wsEndpoint);

		socket.onmessage = function (event) {
			const response = JSON.parse(event.data);
			if(response.uid){
				resolve({socket:socket,uid:response.uid});
			}else{
				onSocketMessage(response);	
			}
		};

		socket.onopen = function () {
			symbolSocket = socket;//デバッグ用
		};

		socket.onerror = function () {
			isSocketFailed = true;
			reject(new Error("Failed to connect to the WebSocket"));

		};

		socket.onclose = async function () {
			if(isSocketFailed){
				return;
			}
			currentWebsocket = await connectWebSocket(targetNode);
			isSocketFailed = false;
			onSocketResumed(currentWebsocket);
		};
	});
}

function socketSend(ws,subscribe){

	ws.socket.send(JSON.stringify({ uid:ws.uid, subscribe: subscribe }));
}

function dispAmount(amount,divisibility){

	const strNum = amount.toString();
	if(divisibility > 0){

		if(amount < Math.pow(10, divisibility)){

			return "0." + paddingAmount0(strNum,0,divisibility);

		}else{

			const r = strNum.slice(-divisibility);
			const l = strNum.substring(0,strNum.length - divisibility);
			return comma3(l) + "." + r;
		}
	}else{
		return comma3(strNum);
	}
}
function comma3(strNum){
	return strNum.replace( /(\d)(?=(\d\d\d)+(?!\d))/g, '$1,');
}

function paddingAmount0(val,char,n){
	for(; val.length < n; val= char + val);
	return val;
}

function dispTimeStamp(timeStamp,epoch){

	const d = new Date(timeStamp + epoch * 1000)
	const strDate = d.getFullYear()%100
		+ "-" + paddingDate0( d.getMonth() + 1 )
		+ '-' + paddingDate0( d.getDate() )
		+ ' ' + paddingDate0( d.getHours() )
		+ ':' + paddingDate0( d.getMinutes() ) ;
	return 	strDate;
}

function getDateId(timeStamp,epoch){
	const d = new Date(timeStamp + epoch * 1000)
	const dateId = d.getFullYear()
		+ paddingDate0( d.getMonth() + 1 )
		+ paddingDate0( d.getDate() );
	return 	dateId;

}

function paddingDate0(num) {
	return ( num < 10 ) ? '0' + num  : num;
};

//QRコードスキャン関連///////////////////////////////////


var canvasElement;
var canvas;

var isMovieScanning = false;
var video = document.createElement("video");

function drawLine(begin, end, color) {
	canvas.beginPath();
	canvas.moveTo(begin.x, begin.y);
	canvas.lineTo(end.x, end.y);
	canvas.lineWidth = 4;
	canvas.strokeStyle = color;
	canvas.stroke();
}

function tick() {
	if(!isMovieScanning){return;}
	if (video.readyState === video.HAVE_ENOUGH_DATA) {
		canvasElement.hidden = false;
		canvasElement.width  = $('.modal-content').width() * 0.9;
		canvasElement.height = $('.modal-content').width() * 0.9 * video.videoHeight / video.videoWidth;
		getCodeInfo(video);
	}
	requestAnimationFrame(tick);
}

function getCodeInfo(src){

	canvas.drawImage(src, 0, 0, canvasElement.width, canvasElement.height);
	var imageData = canvas.getImageData(0, 0, canvasElement.width, canvasElement.height);
	var code = jsQR(imageData.data, imageData.width, imageData.height, {inversionAttempts: "dontInvert"});

	if (code && code.data) {
		isMovieScanning = false;
		drawLine(code.location.topLeftCorner		, code.location.topRightCorner		,"#FF3B58");
		drawLine(code.location.topRightCorner		, code.location.bottomRightCorner	,"#FF3B58");
		drawLine(code.location.bottomRightCorner	, code.location.bottomLeftCorner	,"#FF3B58");
		drawLine(code.location.bottomLeftCorner		, code.location.topLeftCorner		,"#FF3B58");

		try{
			onPhysicalMessage(JSON.parse(code.data));
		}catch{
			onPhysicalMessage(code.data);
		}
	}
}

function startVideo(id){

	isMovieScanning = true;
	canvasElement = document.getElementById(id);
	canvas		  = canvasElement.getContext("2d", { willReadFrequently: true });

	navigator.mediaDevices.getUserMedia({
		video: {
			facingMode: "environment"
		}
	})
	.then(function(stream) {
		video.srcObject = stream;
		window.localStream = stream;
		video.setAttribute("playsinline", true);
		//video.play();
		video.onloadedmetadata = function() {
			video.play(); // メタデータのロードが完了した後に再生を開始
		};
		requestAnimationFrame(tick);
	})
	.catch(function(err) {
		const event = {
			name:"NotFoundError",
			message:err.message
		}
		onStatusChange(event);
	});


}

function stopVideo(){
	if(window.localStream != undefined){
		window.localStream.getTracks().forEach( (track) => {
			track.stop();
		});
	}
}

function clearRect(){

	canvas.clearRect(0, 0, canvasElement.width, canvasElement.height);
}
//ファイル処理関連///////////////////////////////

function scanFileImage(tag){

	isMovieScanning = false;
	canvasElement.hidden = false;

	stopVideo();

	const fileList = document.getElementById(tag).files;
	const reader = new FileReader();
	const file = fileList[0];
	if (file.type == 'image/jpeg' || file.type == 'image/png'){
		reader.readAsDataURL(file, "utf-8");
		reader.onload = (function(_) {
			return function(e) {

				const img = new Image();
				img.src = e.target.result;
				img.onload = function() {
					canvasElement.width  = $('.modal-content').width() * 0.9;
					canvasElement.height = canvasElement.width * img.height / img.width;
					getCodeInfo(img);
				};
			};
		})(file);
	} else {
		alert('JPEGかPNGファイルをアップして下さい');
	}
}
////////////////////////////////////////////////////////

//jsTree関連///////////////////////////////

function createFolder(tree,id,text,parent){

	const node = { id: id,	icon: 'jstree-folder', text: text, state: {'opened': true}};
	$(tree).jstree(true).create_node( parent, node);
}

function createFile(tree, id,text,parent){

	const node = { id: id,	icon: 'jstree-file', text: text, state: {'opened': true}};
	$(tree).jstree(true).create_node( parent, node);
}

async function buildTree(tree,accountNames,signer,signedCosigners){

//	const accountAddresses = tree.map(t=>t.multisigEntries).flat().map(fm=>sym.Address.createFromEncoded(fm.multisig.accountAddress).plain());

	const jstree = new Array();
	for(var level of tree){
		for(var entry of level.multisigEntries){
			
//			const accountNames = await nodeFetchAccountNames(entry.multisig.multisigAddresses.map(ma=>sym.Address.createFromEncoded(ma).plain()));
			if(entry.multisig.multisigAddresses.length > 0){
				for(var address of entry.multisig.multisigAddresses){

					//childの数だけループを回す
					jstree.push(await createChildNode(entry.multisig,address,accountNames,signer,signedCosigners));
				}
			}else{
				jstree.push(await createChildNode(entry.multisig,"#",accountNames,signer,signedCosigners));
			}
		}
	}
	console.log(jstree);
	return jstree;
}

async function createChildNode(multisig,parent,accountNames,signer,signedCosigners){

	const child = new Object();
	const address = sym.Address.createFromEncoded(multisig.accountAddress);
	const accountName = accountNames.find(an=>an.address === multisig.accountAddress).names[0];
//	const names = await nodeFetchAccountNames([address.plain()]);
//		child.text = address.pretty().slice( 0, 13 ) + "..." +	address.pretty().slice( -3 );
	if(accountName){
		child.text = accountName;
	}else{
		child.text = address.pretty().slice( 0, 20 ) + "..." +	address.pretty().slice( -3 );
	}

	if(multisig.accountAddress === signer){
		child.text = "【起案者】" + child.text;
	}

	if(signedCosigners !== undefined && signedCosigners.some(sf=>sf === sym.Address.createFromEncoded(multisig.accountAddress).plain())){
		child.text = "【連署済】" + child.text;

	}
	child.id = multisig.accountAddress;
	child.parent = parent ;
	child.state = {'opened':true};
	if(multisig.cosignatoryAddresses.length > 0){
		const minApproval = multisig.minApproval +","+ multisig.minRemoval + ")-of-" + multisig.cosignatoryAddresses.length;
		child.text = "[(" + minApproval + "] " + child.text;
		child.icon = 'jstree-folder';
	}else{
		child.icon = 'jstree-file';
	}
	return child;
}

async function nodeFetchAccountNames(addresses){
	const res = await nodeFetch(nodeUrl + "/namespaces/account/names","POST",{ "addresses": addresses})
	return JSON.parse(res).accountNames			;
}

async function nodeFetchMosaicNames(mosaicIds){
	const res = await nodeFetch(nodeUrl + "/namespaces/mosaic/names","POST",{ "mosaicIds": mosaicIds})
	return JSON.parse(res).mosaicNames;
}
async function nodeFetchNamespaces(namespaceId){
	const res = await nodeFetch(nodeUrl + "/namespaces/" + namespaceId);
	return JSON.parse(res).namespace;
}


////////////////////////////////////////////////////////

async function getMosaicAsset(itemId){

	var mosaicId;
	if(itemId.constructor.name === "NamespaceId"){
		mosaicId = await nsRepo.getLinkedMosaicId(itemId).toPromise();

	}else{

		mosaicId = itemId;
	}

	var mosaicInfos = await mosaicRepo.getMosaics([mosaicId]).toPromise();
	var mosaicNames = await nsRepo.getMosaicsNames([mosaicId]).toPromise();

	var mosaicLabel;
	var mosaicInfo = mosaicInfos.filter(function(item, index){
	  if (item.id.toHex() == mosaicId.toHex()) return true;
	});
	var mosaicName = mosaicNames.filter(function(item, index){
	  if (item.mosaicId.toHex() == mosaicId.toHex()) return true;
	});
	if (mosaicName[0].names[0]){
		mosaicLabel = mosaicName[0].names[0].name;
	}else{
		mosaicLabel = mosaicName[0].mosaicId.toHex();
	}

	var mosaic = {info:mosaicInfo[0],label:mosaicLabel};
	return mosaic;
}

function clog(nodeUrl,signedTx){

	console.log(nodeUrl + "/transactionStatus/" + signedTx.hash);
	console.log(nodeUrl + "/transactions/confirmed/" + signedTx.hash);
	console.log("https://symbol.fyi/transactions/" + signedTx.hash);
	console.log("https://testnet.symbol.fyi/transactions/" + signedTx.hash);
}
