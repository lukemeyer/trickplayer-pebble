// Copy to local-config.js and fill in. That file is gitignored.
module.exports = {
	server: "https://<your-plex>:32400",
	token: "<X-Plex-Token>",
	timelineRef: 0,
	subtitleRef: "/library/streams/<id>",   // must be a stream with a non-null key
	title: ""
};
