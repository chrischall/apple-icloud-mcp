# Changelog

## [0.2.0](https://github.com/chrischall/apple-icloud-mcp/compare/v0.1.0...v0.2.0) (2026-09-28)


### Features

* add a `doctor` command that runs the healthcheck from a terminal ([#11](https://github.com/chrischall/apple-icloud-mcp/issues/11)) ([f2592f6](https://github.com/chrischall/apple-icloud-mcp/commit/f2592f6b30670de7b354620d74ccaa935f057a9d))


### Bug Fixes

* **calendar:** correct series walks, DST-edge writes and rule guards ([#16](https://github.com/chrischall/apple-icloud-mcp/issues/16)) ([c32bc25](https://github.com/chrischall/apple-icloud-mcp/commit/c32bc25feac2887751fb457b0100240b5ae47b56))
* **calendar:** give floating instances the series' real length, and keep UTC exceptions naming their rule instance ([#20](https://github.com/chrischall/apple-icloud-mcp/issues/20)) ([0e40605](https://github.com/chrischall/apple-icloud-mcp/commit/0e40605088b5da2a1f42f00e6916cad78b48d704))
* **calendar:** keep DURATION nominal, write exact ones in hours, and take a series' new length from the wall clock ([#21](https://github.com/chrischall/apple-icloud-mcp/issues/21)) ([2daf043](https://github.com/chrischall/apple-icloud-mcp/commit/2daf04361fd98c869ff8c754e3f86174083cbc07))
* **calendar:** keep floating events in wall clock and move UNTIL by its compared bound ([#19](https://github.com/chrischall/apple-icloud-mcp/issues/19)) ([75c2d29](https://github.com/chrischall/apple-icloud-mcp/commit/75c2d299f0ae95029ad6d346e805c1749d58d32d))
* **calendar:** measure a series' new length on the request's clock, and let overrides follow it by value ([#22](https://github.com/chrischall/apple-icloud-mcp/issues/22)) ([8f316c2](https://github.com/chrischall/apple-icloud-mcp/commit/8f316c2f5006efddeeee6afc08daf7ea288f66dc))
* **calendar:** move a floating override's end by wall clock when it keeps its own length ([#24](https://github.com/chrischall/apple-icloud-mcp/issues/24)) ([aec7652](https://github.com/chrischall/apple-icloud-mcp/commit/aec7652d214776f22e4dfb20c3d6df0a68cc1312))
* **calendar:** take a series' wall-clock length only when its clock and the request's agree ([#23](https://github.com/chrischall/apple-icloud-mcp/issues/23)) ([75f52d8](https://github.com/chrischall/apple-icloud-mcp/commit/75f52d8cafe5ae1880625c79625f19eae582f8bf))
* close the verified service-review bugs in music, mail, contacts, DAV and weather ([#13](https://github.com/chrischall/apple-icloud-mcp/issues/13)) ([b2a540a](https://github.com/chrischall/apple-icloud-mcp/commit/b2a540ac9957b1c17a0fc76e3c73dcafdaef9689))
* **doctor:** name the real reason when nothing was checked, and fail for an unchecked named service ([#12](https://github.com/chrischall/apple-icloud-mcp/issues/12)) ([d2fe2b7](https://github.com/chrischall/apple-icloud-mcp/commit/d2fe2b75d43a36bc40f7cc4ddf6ec121e1d58f69))
* **music:** count an unconfirmed append batch in create_playlist's write log ([#15](https://github.com/chrischall/apple-icloud-mcp/issues/15)) ([2fc7a2c](https://github.com/chrischall/apple-icloud-mcp/commit/2fc7a2ce6b048d521a2afa54b3f4a8ee6ee951c9))


### Documentation

* point Mac users at apple-swift-mcp's token-free playlist editing ([#9](https://github.com/chrischall/apple-icloud-mcp/issues/9)) ([cb2fed2](https://github.com/chrischall/apple-icloud-mcp/commit/cb2fed2d6cd34c05bb01ec75b0bb492a62cf922d))

## 0.1.0 (2026-09-27)


### Features

* Apple Web Services MCP — Apple Music, iCloud Calendar/Contacts/Mail, Maps, WeatherKit, iTunes ([#3](https://github.com/chrischall/apple-icloud-mcp/issues/3)) ([fdbaeda](https://github.com/chrischall/apple-icloud-mcp/commit/fdbaedae0b01b55da6ac2ba33ae2a883f6d05a2f))


### Refactor

* rename to apple-cloud-mcp so the name no longer reads as Amazon Web Services ([#5](https://github.com/chrischall/apple-icloud-mcp/issues/5)) ([be886bf](https://github.com/chrischall/apple-icloud-mcp/commit/be886bf17b208cf1b4007e8c14d7a8def41127bf))
* rename to apple-icloud-mcp to match the renamed repository ([#7](https://github.com/chrischall/apple-icloud-mcp/issues/7)) ([fdd61d3](https://github.com/chrischall/apple-icloud-mcp/commit/fdd61d327140a4240dbb3227f5c858f24fcb5b8a))
