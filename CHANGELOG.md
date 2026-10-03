# Changelog

## [0.3.1](https://github.com/chrischall/apple-icloud-mcp/compare/v0.3.0...v0.3.1) (2026-10-03)


### Bug Fixes

* **deps:** bump @chrischall/mcp-utils to 2.10.0 ([#35](https://github.com/chrischall/apple-icloud-mcp/issues/35)) ([36c642f](https://github.com/chrischall/apple-icloud-mcp/commit/36c642f4eef8402f5bae0252f88407b8839e2be0))
* **deps:** bump @chrischall/mcp-utils to 2.12.0 ([#37](https://github.com/chrischall/apple-icloud-mcp/issues/37)) ([5df1aab](https://github.com/chrischall/apple-icloud-mcp/commit/5df1aab686ca98c9d03dc9e4f381c44f4017c4e0))
* **deps:** bump @chrischall/mcp-utils to 2.13.0 ([#38](https://github.com/chrischall/apple-icloud-mcp/issues/38)) ([7bae58d](https://github.com/chrischall/apple-icloud-mcp/commit/7bae58de22cb8eb866fb9e31a76f31b187c295c1))
* keep write approvals valid across a hosted restart (mcp-utils 2.11.0) ([#36](https://github.com/chrischall/apple-icloud-mcp/issues/36)) ([660525a](https://github.com/chrischall/apple-icloud-mcp/commit/660525ab2a93a817ba6c0fd7e987c146e5e3bb90))
* report CDN/WAF blocks as edge_blocked, not a rejected credential (mcp-utils 2.9.0) ([#33](https://github.com/chrischall/apple-icloud-mcp/issues/33)) ([9087bfa](https://github.com/chrischall/apple-icloud-mcp/commit/9087bfa527ab6c1bce5992405f6f187e669ebb9e))

## [0.3.0](https://github.com/chrischall/apple-icloud-mcp/compare/v0.2.1...v0.3.0) (2026-09-29)


### Features

* **mail:** download iCloud Mail attachments ([#31](https://github.com/chrischall/apple-icloud-mcp/issues/31)) ([664580e](https://github.com/chrischall/apple-icloud-mcp/commit/664580e0f952bdd954b675fbff3c72ac26466e00))

## [0.2.1](https://github.com/chrischall/apple-icloud-mcp/compare/v0.2.0...v0.2.1) (2026-09-28)


### Bug Fixes

* **calendar:** list a many-day all-day series instance that began days before the window ([#30](https://github.com/chrischall/apple-icloud-mcp/issues/30)) ([42b85fc](https://github.com/chrischall/apple-icloud-mcp/commit/42b85fc4dd40ff57b5937a398d2319eb57d6c2da))
* **calendar:** read floating values in DISPLAY_TZ whatever timeZone a call passes ([#28](https://github.com/chrischall/apple-icloud-mcp/issues/28)) ([4fc2860](https://github.com/chrischall/apple-icloud-mcp/commit/4fc2860285db2beb6fb4a1c11466379b13c7597c))
* **calendar:** write a floating override's wall length through setEnd when its series is zoned ([#25](https://github.com/chrischall/apple-icloud-mcp/issues/25)) ([67d4c38](https://github.com/chrischall/apple-icloud-mcp/commit/67d4c38ea135cba6b9aaf7908fea4916fd81d4a2))


### Performance

* **calendar:** read a zone's offset from Intl once per UTC hour ([#27](https://github.com/chrischall/apple-icloud-mcp/issues/27)) ([8f507e2](https://github.com/chrischall/apple-icloud-mcp/commit/8f507e298805cc809ae277349a974f97ff830278))

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
