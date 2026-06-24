<?php
header('Content-Type: image/png');
header('Cache-Control: public, max-age=86400');

$size = 512;
$img = imagecreatetruecolor($size, $size);
imagealphablending($img, true);
imagesavealpha($img, true);

$bg   = imagecolorallocate($img, 26, 127, 75);
$white= imagecolorallocate($img, 255, 255, 255);
$transparent = imagecolorallocatealpha($img, 0, 0, 0, 127);

imagefill($img, 0, 0, $transparent);
imagefilledellipse($img, $size/2, $size/2, $size, $size, $bg);

$cx = $size / 2;
$pts = [
    $cx,               $size * 0.22,
    $cx - $size*0.26,  $size * 0.65,
    $cx + $size*0.26,  $size * 0.65,
];
imagefilledpolygon($img, array_map('intval', $pts), $white);
imagefilledrectangle($img, intval($cx-$size*0.1), intval($size*0.5), intval($cx+$size*0.1), intval($size*0.63), $bg);

imagepng($img);
imagedestroy($img);
