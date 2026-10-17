<?php
if ($_SERVER['HTTP_HOST'] !== 'mkpc.malahieude.net') {
	echo '<script type="text/javascript">var MK_DEV = true;</script>';
	// filemtime cache-busting: dev scripts change often (3D experiments),
	// and a stale cached copy produces untraceable ghost bugs.
	$mkScripts = array('mk-dev.js', 'three.min.js', 'mk-3d.js', 'mk.js');
	foreach ($mkScripts as $mkScript) {
		$mkPath = $_SERVER['DOCUMENT_ROOT'] . '/scripts/' . $mkScript;
		$mkVer = is_file($mkPath) ? filemtime($mkPath) : 0;
		echo '<script type="text/javascript" src="scripts/' . $mkScript . '?v=' . $mkVer . '"></script>';
	}
}
else
	echo '<script type="text/javascript" src="scripts/mk.v332.js"></script>';
?>
