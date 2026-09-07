git remote add upstream https://code.haverbeke.berlin/wordgard/wordgard.git
git fetch upstream
if git merge-base --is-ancestor upstream/main HEAD; then
	exit 1
else
	START=$(git rev-parse HEAD)
	git merge --no-edit upstream/main
	END=$(git rev-parse HEAD)

	# rename upstream tags to `v*` scheme, if any
	for c in $(git log $START..$END --format=format:%H); do
		TAG=$(git tag --points-at $c)
		VERSION=$(echo $TAG | grep -ohE '^[0-9]+\.[0-9]+\.[0-9]+.*$')
		if [ ! -z $VERSION ]; then
			git tag -a "v$VERSION" $c -m 'from upstream'
			echo "$c $TAG $VERSION"
		fi
	done

	# make a beta release if HEAD isn't tagged
	if ! git describe --exact-match --tags HEAD; then
		npx -p @nerd-bible/config gitBump beta
	fi

	git push --tags origin master
fi
